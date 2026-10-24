// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Universal transit wallet. One deposit, any operator's turnstile.
///
/// - Fares are priced in fiat cents (TRY) and converted to MON with `weiPerCent` (an owner-updated rate that stands
///   in for a price oracle), so a ticket costs the same in lira whatever MON does.
/// - Parallel-friendly: no global counters on the tap path; operator earnings are sharded by rider, and everything a
///   tap writes besides that lives in the rider's own slots.
/// - Gas sponsorship: riders sign an EIP-712 request and anyone (a relayer) submits it with `relay`.
contract Turnike {
    struct Operator {
        address admin;
        address payout;
        uint128 base; // fiat cents
        uint128 perZone; // fiat cents
        uint128 maxFare; // fiat cents
        uint128 dailyCap; // fiat cents per rider per day, 0 = no cap
        uint32 transferWindow; // seconds after a tap-out in which the next tap-in skips the base fare, 0 = off
        uint32 stationCount;
        string name;
    }

    struct Trip {
        uint32 op;
        uint32 station;
        uint16 zone;
        uint64 time;
        bool open;
        bool transfer; // this trip skips the base fare
        uint32 lastOp; // operator of the last completed trip
        uint64 lastOut; // when it ended (0 = none)
    }

    struct Day {
        uint32 day;
        uint224 spent; // wei
    }

    struct Req {
        address rider;
        uint8 action; // 0 tapIn, 1 tapOut, 2 withdraw
        uint32 op;
        uint32 station;
        uint256 amount; // withdraw amount
        address to; // withdraw destination
        uint256 nonce;
        uint256 deadline;
    }

    address public owner;
    bool public paused;
    uint256 public weiPerCent;
    uint32 public maxTrip = 4 hours;
    uint32 public operatorCount;

    mapping(uint32 => Operator) public operators;
    mapping(uint32 => mapping(uint32 => uint16)) public stationZone;
    mapping(address => uint256) public balances;
    mapping(address => Trip) public trips;
    mapping(address => uint256) public nonces;
    mapping(address => mapping(uint32 => Day)) public daily;
    mapping(uint32 => uint256[16]) private earnings;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant REQ_TYPEHASH = keccak256(
        "Req(address rider,uint8 action,uint32 op,uint32 station,uint256 amount,address to,uint256 nonce,uint256 deadline)"
    );

    event OperatorRegistered(uint32 indexed op, string name, address payout);
    event StationAdded(uint32 indexed op, uint32 indexed station, uint16 zone);
    event Deposited(address indexed rider, uint256 amount);
    event Withdrawn(address indexed rider, uint256 amount);
    event TapIn(address indexed rider, uint32 indexed op, uint32 station);
    event TapOut(address indexed rider, uint32 indexed op, uint32 fromStation, uint32 toStation, uint256 fare);
    event Penalty(address indexed rider, uint32 indexed op, uint256 fare);
    event TransferApplied(address indexed rider, uint32 indexed op);
    event TripExpired(address indexed rider, uint32 indexed op, uint256 fare);
    event Refunded(uint32 indexed op, address indexed rider, uint256 amount);
    event Claimed(uint32 indexed op, address payout, uint256 amount);
    event RateSet(uint256 weiPerCent);
    event PausedSet(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint256 initialWeiPerCent) {
        require(initialWeiPerCent != 0, "bad rate");
        owner = msg.sender;
        weiPerCent = initialWeiPerCent;
    }

    // ---------------------------------------------------------------- admin

    function setRate(uint256 newWeiPerCent) external onlyOwner {
        require(newWeiPerCent != 0, "bad rate");
        weiPerCent = newWeiPerCent;
        emit RateSet(newWeiPerCent);
    }

    function setMaxTrip(uint32 seconds_) external onlyOwner {
        require(seconds_ >= 10 minutes, "too short");
        maxTrip = seconds_;
    }

    /// Stops new trips and new relayed taps. Riders can still tap out, withdraw and top up.
    function pause() external onlyOwner {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    function registerOperator(
        string calldata name,
        address payout,
        uint128 base,
        uint128 perZone,
        uint128 maxFare,
        uint128 dailyCap,
        uint32 transferWindow
    ) external returns (uint32 op) {
        require(payout != address(0) && maxFare >= base, "bad operator");
        op = ++operatorCount;
        Operator storage o = operators[op];
        o.admin = msg.sender;
        o.payout = payout;
        o.base = base;
        o.perZone = perZone;
        o.maxFare = maxFare;
        o.dailyCap = dailyCap;
        o.transferWindow = transferWindow;
        o.name = name;
        emit OperatorRegistered(op, name, payout);
    }

    function addStation(uint32 op, uint16 zone) external returns (uint32 station) {
        Operator storage o = operators[op];
        require(o.admin == msg.sender, "not admin");
        station = ++o.stationCount;
        stationZone[op][station] = zone;
        emit StationAdded(op, station, zone);
    }

    /// Operator admin gives money back to a rider out of that operator's earnings.
    function refund(uint32 op, address rider, uint256 amount) external {
        require(operators[op].admin == msg.sender, "not admin");
        uint256 left = amount;
        uint256 s = _shard(rider);
        for (uint256 k; k < 16 && left > 0; k++) {
            uint256 i = (s + k) & 15;
            uint256 have = earnings[op][i];
            uint256 take = have < left ? have : left;
            if (take > 0) {
                earnings[op][i] = have - take;
                left -= take;
            }
        }
        require(left == 0, "not enough earnings");
        balances[rider] += amount;
        emit Refunded(op, rider, amount);
    }

    // --------------------------------------------------------------- money

    function deposit() external payable {
        _deposit(msg.sender);
    }

    /// Anyone can top up any rider (a card payment processed off-chain, a friend, another wallet).
    function depositFor(address rider) external payable {
        _deposit(rider);
    }

    function withdraw(uint256 amount) external {
        _withdraw(msg.sender, amount, msg.sender);
    }

    function withdrawTo(uint256 amount, address to) external {
        _withdraw(msg.sender, amount, to);
    }

    function _deposit(address rider) private {
        balances[rider] += msg.value;
        emit Deposited(rider, msg.value);
    }

    function _withdraw(address rider, uint256 amount, address to) private {
        require(!trips[rider].open, "trip open");
        require(to != address(0), "zero address");
        balances[rider] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
        emit Withdrawn(rider, amount);
    }

    // ---------------------------------------------------------------- fares

    function _fareCents(Operator storage o, uint16 zoneA, uint16 zoneB, bool transfer) private view returns (uint256 c) {
        uint256 d = zoneA > zoneB ? zoneA - zoneB : zoneB - zoneA;
        c = (transfer ? 0 : uint256(o.base)) + d * o.perZone;
        if (c > o.maxFare) c = o.maxFare;
    }

    /// Fare in wei for a normal trip between two zones.
    function fare(uint32 op, uint16 zoneA, uint16 zoneB) public view returns (uint256) {
        return _fareCents(operators[op], zoneA, zoneB, false) * weiPerCent;
    }

    /// Fare in wei for a trip that starts as a transfer (no base fare).
    function fareTransfer(uint32 op, uint16 zoneA, uint16 zoneB) public view returns (uint256) {
        return _fareCents(operators[op], zoneA, zoneB, true) * weiPerCent;
    }

    function _applyDailyCap(address rider, uint32 op, Operator storage o, uint256 f) private returns (uint256) {
        uint256 cap = uint256(o.dailyCap) * weiPerCent;
        if (cap == 0) return f;
        Day storage d = daily[rider][op];
        uint32 today = uint32(block.timestamp / 1 days);
        if (d.day != today) {
            d.day = today;
            d.spent = 0;
        }
        uint256 left = cap > d.spent ? cap - d.spent : 0;
        if (f > left) f = left;
        d.spent += uint224(f);
        return f;
    }

    // ----------------------------------------------------------------- taps

    function tapIn(uint32 op, uint32 station) external {
        _tapIn(msg.sender, op, station);
    }

    function tapOut(uint32 op, uint32 station) external {
        _tapOut(msg.sender, op, station);
    }

    function _tapIn(address rider, uint32 op, uint32 station) private {
        require(!paused, "paused");
        Operator storage o = operators[op];
        require(station != 0 && station <= o.stationCount, "bad station");
        Trip storage t = trips[rider];
        uint256 bal = balances[rider];
        bool penalized;

        if (t.open) {
            uint256 pen = uint256(operators[t.op].maxFare) * weiPerCent;
            if (pen > bal) pen = bal;
            bal -= pen;
            earnings[t.op][_shard(rider)] += pen;
            penalized = true;
            emit Penalty(rider, t.op, pen);
        }

        require(bal >= uint256(o.maxFare) * weiPerCent, "balance < max fare");
        balances[rider] = bal;

        bool xfer = !penalized && o.transferWindow != 0 && t.lastOut != 0 && t.lastOp == op
            && block.timestamp <= uint256(t.lastOut) + o.transferWindow;

        t.op = op;
        t.station = station;
        t.zone = stationZone[op][station];
        t.time = uint64(block.timestamp);
        t.open = true;
        t.transfer = xfer;
        emit TapIn(rider, op, station);
        if (xfer) emit TransferApplied(rider, op);
    }

    function _tapOut(address rider, uint32 op, uint32 station) private {
        Trip storage t = trips[rider];
        require(t.open, "no open trip");
        require(t.op == op, "other operator");
        Operator storage o = operators[op];
        require(station != 0 && station <= o.stationCount, "bad station");

        uint256 f;
        if (block.timestamp > uint256(t.time) + maxTrip) {
            f = uint256(o.maxFare) * weiPerCent; // the trip was left open far too long: maximum fare
        } else {
            f = _fareCents(o, t.zone, stationZone[op][station], t.transfer) * weiPerCent;
            f = _applyDailyCap(rider, op, o, f);
        }
        uint256 bal = balances[rider];
        if (f > bal) f = bal; // only possible if the rate rose during the trip
        balances[rider] = bal - f;
        earnings[op][_shard(rider)] += f;

        uint32 from = t.station;
        t.open = false;
        t.lastOp = op;
        t.lastOut = uint64(block.timestamp);
        emit TapOut(rider, op, from, station, f);
    }

    /// Anyone can close a trip that has been open longer than `maxTrip`; the rider pays that operator's maximum fare.
    function expire(address rider) external {
        Trip storage t = trips[rider];
        require(t.open, "no open trip");
        require(block.timestamp > uint256(t.time) + maxTrip, "not expired");
        uint32 op = t.op;
        uint256 f = uint256(operators[op].maxFare) * weiPerCent;
        uint256 bal = balances[rider];
        if (f > bal) f = bal;
        balances[rider] = bal - f;
        earnings[op][_shard(rider)] += f;
        t.open = false;
        t.lastOut = 0; // no transfer discount after a forgotten trip
        emit TripExpired(rider, op, f);
    }

    // ---------------------------------------------------- gas sponsorship

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Turnike"), keccak256("1"), block.chainid, address(this)));
    }

    /// EIP-712 digest a rider signs for `relay`.
    function hashReq(Req calldata r) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(REQ_TYPEHASH, r))));
    }

    /// Executes a rider-signed request; the submitter pays the gas. The nonce is per rider (their own slot).
    function relay(Req calldata r, bytes calldata sig) external {
        require(block.timestamp <= r.deadline, "expired");
        require(r.nonce == nonces[r.rider], "bad nonce");
        require(_recover(hashReq(r), sig) == r.rider, "bad signature");
        nonces[r.rider] = r.nonce + 1;

        if (r.action == 0) {
            _tapIn(r.rider, r.op, r.station);
        } else if (r.action == 1) {
            _tapOut(r.rider, r.op, r.station);
        } else if (r.action == 2) {
            _withdraw(r.rider, r.amount, r.to);
        } else {
            revert("bad action");
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad signature");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad signature");
        require(v == 27 || v == 28, "bad signature");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signature");
        return signer;
    }

    // ------------------------------------------------------------ earnings

    function pending(uint32 op) public view returns (uint256 sum) {
        for (uint256 i; i < 16; i++) {
            sum += earnings[op][i];
        }
    }

    /// Anyone can trigger; funds always go to the operator's payout address.
    function claim(uint32 op) external {
        uint256 sum = pending(op);
        for (uint256 i; i < 16; i++) {
            earnings[op][i] = 0;
        }
        address payout = operators[op].payout;
        (bool ok,) = payout.call{value: sum}("");
        require(ok, "send failed");
        emit Claimed(op, payout, sum);
    }

    function _shard(address rider) private pure returns (uint256) {
        return uint160(rider) & 15;
    }
}
