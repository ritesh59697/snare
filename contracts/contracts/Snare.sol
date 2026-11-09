// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint64, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Snare
/// @notice Booby-trap a vault and log off. Raiders run routes against traps that only the
///         chain can evaluate, and nobody sees a trap that does not fire.
/// @dev The vault is an 8x8 grid held in encrypted 64-bit masks: tile `y * 8 + x` is one bit.
///      Routes are public. Layouts, outcomes and gold balances are encrypted.
contract Snare is ZamaEthereumConfig {
    /// @dev Structural: one tile per bit of a euint64, so these cannot be tuned independently.
    uint8 public constant GRID_WIDTH = 8;
    uint8 public constant TILE_COUNT = 64;

    struct Config {
        uint64 starterGold;
        uint64 ticketPrice;
        uint64 scanPrice;
        uint64 stashValue;
        uint8 trapCount;
        uint8 stashCount;
        uint8 maxRouteLength;
        uint16 maxRaidsPerVault;
        uint32 vaultLifetime;
    }

    enum Status {
        Active,
        Retired,
        Verified
    }

    struct Vault {
        address owner; // address(0) marks a house vault
        uint64 expiresAt;
        Status status;
        euint64 traps;
        euint64[] stashes; // as funded at creation, never changes
        euint64[] remaining; // shrinks as stashes are looted
        uint64 clearTraps;
        uint64[] clearStashes;
    }

    struct Raid {
        address raider;
        uint8[] route;
        euint64 jam;
        euint64 traveled;
        euint64 clicks;
        euint64 payout;
        ebool escaped;
    }

    struct Scan {
        uint8 center;
        bool forStash;
        ebool found;
    }

    Config private _config;
    uint256 public vaultCount;

    mapping(uint256 vaultId => Vault) private _vaults;
    mapping(uint256 vaultId => Raid[]) private _raids;
    mapping(uint256 vaultId => mapping(address scanner => Scan[])) private _scans;
    mapping(address player => euint64) private _gold;
    mapping(address player => bool) public hasClaimed;

    event StarterClaimed(address indexed player);
    event VaultCreated(uint256 indexed vaultId, address indexed owner, uint64 expiresAt);
    event Raided(uint256 indexed vaultId, uint256 indexed raidIndex, address indexed raider, uint8[] route);
    event Scanned(uint256 indexed vaultId, address indexed scanner, uint256 scanIndex, uint8 center, bool forStash);
    event VaultRetired(uint256 indexed vaultId);
    event VaultVerified(uint256 indexed vaultId, uint64 traps, uint64[] stashes);

    error InvalidConfig();
    error AlreadyClaimed();
    error NotClaimed();
    error WrongLayoutSize();
    error UnknownVault();
    error VaultClosed();
    error VaultStillActive();
    error NotRetired();
    error OwnVault();
    error NotAllowedToRetire();
    error TileOutOfRange(uint8 tile);
    error RouteLength(uint256 length);
    error BadStart(uint8 tile);
    error BadExit(uint8 tile);
    error NotAdjacent(uint8 from, uint8 to);
    error TileRepeated(uint8 tile);
    error ReplayMismatch(uint256 raidIndex);

    constructor(Config memory config_) {
        // A wall across the grid takes GRID_WIDTH traps, so fewer always leaves a clean route.
        if (config_.trapCount == 0 || config_.trapCount >= GRID_WIDTH) revert InvalidConfig();
        if (config_.stashCount == 0) revert InvalidConfig();
        if (config_.maxRouteLength < GRID_WIDTH) revert InvalidConfig();
        if (config_.maxRaidsPerVault == 0 || config_.vaultLifetime == 0) revert InvalidConfig();
        if (config_.ticketPrice == 0 || config_.stashValue == 0) revert InvalidConfig();
        _config = config_;
    }

    // ------------------------------------------------------------------ gold

    /// @notice Grants the one-time starting balance, readable only by the caller.
    function claimStarter() external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();
        hasClaimed[msg.sender] = true;
        _setGold(msg.sender, FHE.asEuint64(_config.starterGold));
        emit StarterClaimed(msg.sender);
    }

    // ---------------------------------------------------------------- vaults

    /// @notice Builds a vault from encrypted tile positions.
    /// @dev Each position becomes exactly one bit, so the budget holds by construction and the
    ///      owner never has to prove anything about the layout. A shift wraps modulo 64, so every
    ///      value lands on the grid. Doubled-up tiles only waste the owner's own budget. If the
    ///      owner cannot afford the stashes they are created empty, since an encrypted balance
    ///      cannot cause a revert without leaking it.
    function createVault(
        externalEuint8[] calldata trapTiles,
        externalEuint8[] calldata stashTiles,
        bytes calldata inputProof
    ) external returns (uint256 vaultId) {
        if (!hasClaimed[msg.sender]) revert NotClaimed();
        if (trapTiles.length != _config.trapCount || stashTiles.length != _config.stashCount) {
            revert WrongLayoutSize();
        }

        euint8[] memory traps = new euint8[](trapTiles.length);
        for (uint256 i; i < trapTiles.length; ++i) {
            traps[i] = FHE.fromExternal(trapTiles[i], inputProof);
        }
        euint8[] memory stashes = new euint8[](stashTiles.length);
        for (uint256 i; i < stashTiles.length; ++i) {
            stashes[i] = FHE.fromExternal(stashTiles[i], inputProof);
        }

        euint64 balance = _gold[msg.sender];
        uint64 cost = _config.stashValue * _config.stashCount;
        ebool funded = FHE.ge(balance, cost);
        _setGold(msg.sender, FHE.select(funded, FHE.sub(balance, cost), balance));

        vaultId = _storeVault(msg.sender, traps, stashes, funded);
    }

    /// @notice Spawns a vault whose layout comes from encrypted randomness. Nobody has ever seen
    ///         it, including the deployer and the caller, and it is funded by the game.
    function createHouseVault() external returns (uint256 vaultId) {
        euint8[] memory traps = new euint8[](_config.trapCount);
        for (uint256 i; i < traps.length; ++i) {
            traps[i] = FHE.randEuint8(TILE_COUNT);
        }
        euint8[] memory stashes = new euint8[](_config.stashCount);
        for (uint256 i; i < stashes.length; ++i) {
            stashes[i] = FHE.randEuint8(TILE_COUNT);
        }
        vaultId = _storeVault(address(0), traps, stashes, FHE.asEbool(true));
    }

    function _storeVault(
        address owner,
        euint8[] memory trapTiles,
        euint8[] memory stashTiles,
        ebool funded
    ) private returns (uint256 vaultId) {
        vaultId = vaultCount++;
        Vault storage vault = _vaults[vaultId];
        vault.owner = owner;
        vault.expiresAt = uint64(block.timestamp) + _config.vaultLifetime;

        euint64 one = FHE.asEuint64(1);
        euint64 zero = FHE.asEuint64(0);

        euint64 traps = zero;
        for (uint256 i; i < trapTiles.length; ++i) {
            traps = FHE.or(traps, FHE.shl(one, trapTiles[i]));
        }
        vault.traps = traps;
        _share(traps, owner);

        for (uint256 i; i < stashTiles.length; ++i) {
            euint64 stash = FHE.select(funded, FHE.shl(one, stashTiles[i]), zero);
            vault.stashes.push(stash);
            vault.remaining.push(stash);
            _share(stash, owner);
        }

        emit VaultCreated(vaultId, owner, vault.expiresAt);
    }

    // ---------------------------------------------------------------- raiding

    /// @notice Runs a route through a vault. The result is readable only by raider and owner.
    /// @dev The tile a raider is caught on is included in `traveled`, tiles beyond it are not, so a
    ///      raid reveals at most one armed trap to the raider and nothing to anyone else. The outcome
    ///      is unknown inside the transaction, so a raider cannot simulate and revert a bad result.
    function raid(uint256 vaultId, uint8[] calldata route) external returns (uint256 raidIndex) {
        Vault storage vault = _openVault(vaultId);
        if (vault.owner == msg.sender) revert OwnVault();
        if (!hasClaimed[msg.sender]) revert NotClaimed();
        _validateRoute(route);

        euint64 balance = _gold[msg.sender];
        ebool funded = FHE.ge(balance, _config.ticketPrice);
        _gold[msg.sender] = FHE.select(funded, FHE.sub(balance, _config.ticketPrice), balance);

        raidIndex = _raids[vaultId].length;
        Raid storage result = _raids[vaultId].push();
        result.raider = msg.sender;
        result.route = route;
        _walk(vault, result, funded);
        result.payout = _loot(vault, result);
        _settle(vault.owner, result, funded);

        emit Raided(vaultId, raidIndex, msg.sender, route);
    }

    /// @dev Moves the raider tile by tile. After a trap fires, `alive` is false and later tiles are
    ///      not added to `traveled`. ANDing two random words jams each tile with probability 1/4.
    function _walk(Vault storage vault, Raid storage result, ebool funded) private {
        euint64 jam = FHE.and(FHE.randEuint64(), FHE.randEuint64());
        euint64 armed = FHE.and(vault.traps, FHE.not(jam));
        euint64 zero = FHE.asEuint64(0);

        ebool alive = funded;
        euint64 traveled = zero;
        uint8[] storage route = result.route;
        for (uint256 i; i < route.length; ++i) {
            uint64 bit = uint64(1) << route[i];
            traveled = FHE.or(traveled, FHE.select(alive, FHE.asEuint64(bit), zero));
            alive = FHE.and(alive, FHE.not(FHE.ne(FHE.and(armed, bit), uint64(0))));
        }

        result.jam = jam;
        result.traveled = traveled;
        result.clicks = FHE.and(FHE.and(vault.traps, jam), traveled);
        result.escaped = alive;
    }

    /// @dev Empties every live stash on an escaped route and returns what it was worth.
    function _loot(Vault storage vault, Raid storage result) private returns (euint64 payout) {
        euint64 zero = FHE.asEuint64(0);
        euint64 stashValue = FHE.asEuint64(_config.stashValue);
        payout = zero;
        for (uint256 i; i < vault.remaining.length; ++i) {
            euint64 stash = vault.remaining[i];
            ebool looted = FHE.and(result.escaped, FHE.ne(FHE.and(stash, result.traveled), uint64(0)));
            payout = FHE.add(payout, FHE.select(looted, stashValue, zero));
            vault.remaining[i] = FHE.select(looted, zero, stash);
            _share(vault.remaining[i], vault.owner);
        }
    }

    /// @dev An escape refunds the ticket. A caught raider forfeits it to the vault owner.
    function _settle(address owner, Raid storage result, ebool funded) private {
        address raider = result.raider;
        euint64 zero = FHE.asEuint64(0);
        euint64 ticket = FHE.asEuint64(_config.ticketPrice);
        ebool escaped = result.escaped;

        euint64 refund = FHE.select(escaped, ticket, zero);
        _setGold(raider, FHE.add(_gold[raider], FHE.add(refund, result.payout)));
        if (owner != address(0)) {
            ebool forfeited = FHE.and(funded, FHE.not(escaped));
            _setGold(owner, FHE.add(_gold[owner], FHE.select(forfeited, ticket, zero)));
        }

        FHE.allowThis(result.jam);
        _shareWith(result.traveled, raider, owner);
        _shareWith(result.clicks, raider, owner);
        _shareWith(result.payout, raider, owner);
        FHE.allowThis(escaped);
        FHE.allow(escaped, raider);
        if (owner != address(0)) FHE.allow(escaped, owner);
    }

    /// @notice Privately asks whether a 3x3 area around `center` holds a trap or a live stash.
    /// @dev A caller who cannot afford the scan gets an encrypted `false`, because the encrypted
    ///      balance cannot revert. The scanned tile is public, the answer is not.
    function scan(uint256 vaultId, uint8 center, bool forStash) external returns (uint256 scanIndex) {
        Vault storage vault = _openVault(vaultId);
        if (vault.owner == msg.sender) revert OwnVault();
        if (!hasClaimed[msg.sender]) revert NotClaimed();
        if (center >= TILE_COUNT) revert TileOutOfRange(center);

        euint64 balance = _gold[msg.sender];
        ebool funded = FHE.ge(balance, _config.scanPrice);
        _setGold(msg.sender, FHE.select(funded, FHE.sub(balance, _config.scanPrice), balance));

        euint64 hidden = vault.traps;
        if (forStash) {
            hidden = vault.remaining[0];
            for (uint256 i = 1; i < vault.remaining.length; ++i) {
                hidden = FHE.or(hidden, vault.remaining[i]);
            }
        }
        ebool found = FHE.and(funded, FHE.ne(FHE.and(hidden, areaMask(center)), uint64(0)));
        FHE.allowThis(found);
        FHE.allow(found, msg.sender);

        Scan[] storage scans = _scans[vaultId][msg.sender];
        scanIndex = scans.length;
        scans.push(Scan({center: center, forStash: forStash, found: found}));
        emit Scanned(vaultId, msg.sender, scanIndex, center, forStash);
    }

    // ------------------------------------------------------------- retirement

    /// @notice Closes a vault, refunds unlooted stashes and opens the whole history for decryption.
    /// @dev The owner may retire at any time. Anyone may once the vault expired or is full, which is
    ///      the only way a house vault retires.
    function retire(uint256 vaultId) external {
        Vault storage vault = _vaults[vaultId];
        if (vaultId >= vaultCount) revert UnknownVault();
        if (vault.status != Status.Active) revert VaultClosed();
        bool ended = block.timestamp >= vault.expiresAt || _raids[vaultId].length >= _config.maxRaidsPerVault;
        if (msg.sender != vault.owner && !ended) revert NotAllowedToRetire();
        vault.status = Status.Retired;

        if (vault.owner != address(0)) {
            euint64 zero = FHE.asEuint64(0);
            euint64 stashValue = FHE.asEuint64(_config.stashValue);
            euint64 balance = _gold[vault.owner];
            for (uint256 i; i < vault.remaining.length; ++i) {
                ebool unlooted = FHE.ne(vault.remaining[i], uint64(0));
                balance = FHE.add(balance, FHE.select(unlooted, stashValue, zero));
            }
            _setGold(vault.owner, balance);
        }

        FHE.makePubliclyDecryptable(vault.traps);
        for (uint256 i; i < vault.stashes.length; ++i) {
            FHE.makePubliclyDecryptable(vault.stashes[i]);
        }
        Raid[] storage raids = _raids[vaultId];
        for (uint256 i; i < raids.length; ++i) {
            FHE.makePubliclyDecryptable(raids[i].jam);
            FHE.makePubliclyDecryptable(raids[i].traveled);
            FHE.makePubliclyDecryptable(raids[i].escaped);
            FHE.makePubliclyDecryptable(raids[i].payout);
        }
        emit VaultRetired(vaultId);
    }

    /// @notice Handles to decrypt for `verifyReveal`, in the exact order the proof must cover:
    ///         traps, each stash, then jam, traveled, escaped, payout for each raid.
    function revealHandles(uint256 vaultId) public view returns (bytes32[] memory handles) {
        Vault storage vault = _vaults[vaultId];
        Raid[] storage raids = _raids[vaultId];
        handles = new bytes32[](1 + vault.stashes.length + raids.length * 4);
        uint256 cursor;
        handles[cursor++] = FHE.toBytes32(vault.traps);
        for (uint256 i; i < vault.stashes.length; ++i) {
            handles[cursor++] = FHE.toBytes32(vault.stashes[i]);
        }
        for (uint256 i; i < raids.length; ++i) {
            handles[cursor++] = FHE.toBytes32(raids[i].jam);
            handles[cursor++] = FHE.toBytes32(raids[i].traveled);
            handles[cursor++] = FHE.toBytes32(raids[i].escaped);
            handles[cursor++] = FHE.toBytes32(raids[i].payout);
        }
    }

    /// @notice Checks the decryption proof, then replays every raid in plaintext and reverts unless
    ///         each one matches what the encrypted computation produced at the time.
    function verifyReveal(uint256 vaultId, bytes calldata clearValues, bytes calldata proof) external {
        Vault storage vault = _vaults[vaultId];
        if (vault.status == Status.Verified) revert VaultClosed();
        if (vault.status != Status.Retired) revert NotRetired();

        FHE.checkSignatures(revealHandles(vaultId), clearValues, proof);

        uint256 cursor;
        uint64 traps = uint64(_wordAt(clearValues, cursor++));
        uint256 stashCount = vault.stashes.length;
        uint64[] memory stashes = new uint64[](stashCount);
        bool[] memory taken = new bool[](stashCount);
        for (uint256 i; i < stashCount; ++i) {
            stashes[i] = uint64(_wordAt(clearValues, cursor++));
        }

        Raid[] storage raids = _raids[vaultId];
        for (uint256 r; r < raids.length; ++r) {
            uint64 jam = uint64(_wordAt(clearValues, cursor++));
            uint64 traveled = uint64(_wordAt(clearValues, cursor++));
            bool escaped = _wordAt(clearValues, cursor++) != 0;
            uint64 payout = uint64(_wordAt(clearValues, cursor++));

            // A raider who could not pay the ticket never enters, so nothing is traveled.
            (uint64 expectedTraveled, bool expectedEscaped) = traveled == 0
                ? (uint64(0), false)
                : replayRoute(traps, jam, raids[r].route);
            uint64 expectedPayout;
            if (expectedEscaped) {
                for (uint256 i; i < stashCount; ++i) {
                    if (!taken[i] && stashes[i] & expectedTraveled != 0) {
                        taken[i] = true;
                        expectedPayout += _config.stashValue;
                    }
                }
            }
            if (traveled != expectedTraveled || escaped != expectedEscaped || payout != expectedPayout) {
                revert ReplayMismatch(r);
            }
        }

        vault.status = Status.Verified;
        vault.clearTraps = traps;
        vault.clearStashes = stashes;
        emit VaultVerified(vaultId, traps, stashes);
    }

    /// @notice The plaintext twin of the raid loop, so anyone can check a revealed raid.
    function replayRoute(
        uint64 traps,
        uint64 jam,
        uint8[] memory route
    ) public pure returns (uint64 traveled, bool escaped) {
        uint64 armed = traps & ~jam;
        for (uint256 i; i < route.length; ++i) {
            uint64 bit = uint64(1) << route[i];
            traveled |= bit;
            if (armed & bit != 0) return (traveled, false);
        }
        return (traveled, true);
    }

    /// @notice The 3x3 block of tiles around `center`, clipped at the grid edges.
    function areaMask(uint8 center) public pure returns (uint64 mask) {
        if (center >= TILE_COUNT) revert TileOutOfRange(center);
        int16 width = int16(uint16(GRID_WIDTH));
        int16 x = int16(uint16(center)) % width;
        int16 y = int16(uint16(center)) / width;
        for (int16 dy = -1; dy <= 1; ++dy) {
            for (int16 dx = -1; dx <= 1; ++dx) {
                int16 nx = x + dx;
                int16 ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= width) continue;
                mask |= uint64(1) << uint16(ny * width + nx);
            }
        }
    }

    // ------------------------------------------------------------------ views

    function config() external view returns (Config memory) {
        return _config;
    }

    function goldOf(address player) external view returns (euint64) {
        return _gold[player];
    }

    function getVault(
        uint256 vaultId
    )
        external
        view
        returns (
            address owner,
            uint64 expiresAt,
            Status status,
            uint256 raidCount,
            euint64 traps,
            euint64[] memory stashes,
            euint64[] memory remaining,
            uint64 clearTraps,
            uint64[] memory clearStashes
        )
    {
        if (vaultId >= vaultCount) revert UnknownVault();
        Vault storage vault = _vaults[vaultId];
        return (
            vault.owner,
            vault.expiresAt,
            vault.status,
            _raids[vaultId].length,
            vault.traps,
            vault.stashes,
            vault.remaining,
            vault.clearTraps,
            vault.clearStashes
        );
    }

    function getRaid(uint256 vaultId, uint256 raidIndex) external view returns (Raid memory) {
        return _raids[vaultId][raidIndex];
    }

    function getScans(uint256 vaultId, address scanner) external view returns (Scan[] memory) {
        return _scans[vaultId][scanner];
    }

    // --------------------------------------------------------------- internals

    function _openVault(uint256 vaultId) private view returns (Vault storage vault) {
        if (vaultId >= vaultCount) revert UnknownVault();
        vault = _vaults[vaultId];
        if (
            vault.status != Status.Active ||
            block.timestamp >= vault.expiresAt ||
            _raids[vaultId].length >= _config.maxRaidsPerVault
        ) {
            revert VaultClosed();
        }
    }

    function _validateRoute(uint8[] calldata route) private view {
        if (route.length < GRID_WIDTH || route.length > _config.maxRouteLength) {
            revert RouteLength(route.length);
        }
        if (route[0] >= GRID_WIDTH) revert BadStart(route[0]);
        uint8 last = route[route.length - 1];
        if (last >= TILE_COUNT) revert TileOutOfRange(last);
        if (last < TILE_COUNT - GRID_WIDTH) revert BadExit(last);

        uint64 seen = uint64(1) << route[0];
        for (uint256 i = 1; i < route.length; ++i) {
            uint8 from = route[i - 1];
            uint8 to = route[i];
            if (to >= TILE_COUNT) revert TileOutOfRange(to);
            uint64 bit = uint64(1) << to;
            if (seen & bit != 0) revert TileRepeated(to);
            seen |= bit;
            if (!_adjacent(from, to)) revert NotAdjacent(from, to);
        }
    }

    function _adjacent(uint8 a, uint8 b) private pure returns (bool) {
        (uint8 low, uint8 high) = a < b ? (a, b) : (b, a);
        if (high - low == GRID_WIDTH) return true;
        return high - low == 1 && high % GRID_WIDTH != 0;
    }

    function _wordAt(bytes calldata data, uint256 index) private pure returns (uint256) {
        return uint256(bytes32(data[index * 32:(index + 1) * 32]));
    }

    function _setGold(address player, euint64 value) private {
        _gold[player] = value;
        FHE.allowThis(value);
        FHE.allow(value, player);
    }

    function _share(euint64 value, address owner) private {
        FHE.allowThis(value);
        if (owner != address(0)) FHE.allow(value, owner);
    }

    function _shareWith(euint64 value, address raider, address owner) private {
        _share(value, owner);
        FHE.allow(value, raider);
    }
}
