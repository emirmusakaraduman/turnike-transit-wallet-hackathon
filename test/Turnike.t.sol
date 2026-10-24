// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Turnike} from "../src/Turnike.sol";

contract TurnikeTest is Test {
    uint256 constant RATE = 1e13; // 1 fiat cent = 0.00001 MON, so 1000 cents = 0.01 MON

    Turnike t;
    address payout1 = address(0xA11CE);
    address payout2 = address(0xB0B);
    address rider = address(0x1001);
    uint32 op1;
    uint32 op2;

    function setUp() public {
        t = new Turnike(RATE);
        // Ankara: base 10.00, per zone 5.00, max 50.00, daily cap 150.00, transfer window 1 h
        op1 = t.registerOperator("Ankara", payout1, 1000, 500, 5000, 15000, 3600);
        t.addStation(op1, 0);
        t.addStation(op1, 1);
        t.addStation(op1, 3);
        // Istanbul: base 20.00, per zone 10.00, max 40.00, no cap, no transfer discount
        op2 = t.registerOperator("Istanbul", payout2, 2000, 1000, 4000, 0, 0);
        t.addStation(op2, 0);
        t.addStation(op2, 5);
        vm.deal(rider, 10 ether);
    }

    // ---------------------------------------------------------------- basics

    function test_FareAndBalance() public {
        vm.startPrank(rider);
        vm.expectRevert("balance < max fare");
        t.tapIn(op1, 1);
        t.deposit{value: 0.1 ether}();
        t.tapIn(op1, 1);
        t.tapOut(op1, 3);
        vm.stopPrank();
        assertEq(t.balances(rider), 0.1 ether - 0.025 ether);
        assertEq(t.pending(op1), 0.025 ether);
        (,,,, bool open,,,) = t.trips(rider);
        assertFalse(open);
    }

    function test_FareCappedAtMax() public view {
        assertEq(t.fare(op2, 0, 5), 0.04 ether);
        assertEq(t.fare(op2, 5, 5), 0.02 ether);
    }

    function test_PenaltyWhenForgotTapOut() public {
        vm.startPrank(rider);
        t.deposit{value: 0.1 ether}();
        t.tapIn(op1, 1);
        t.tapIn(op2, 1);
        vm.stopPrank();
        assertEq(t.balances(rider), 0.05 ether);
        assertEq(t.pending(op1), 0.05 ether);
        (uint32 op,,,, bool open,,,) = t.trips(rider);
        assertEq(op, op2);
        assertTrue(open);
    }

    function test_WithdrawBlockedWhileTripOpen() public {
        vm.startPrank(rider);
        t.deposit{value: 0.1 ether}();
        t.tapIn(op1, 1);
        vm.expectRevert("trip open");
        t.withdraw(0.01 ether);
        t.tapOut(op1, 2);
        uint256 before = rider.balance;
        t.withdraw(0.05 ether);
        vm.stopPrank();
        assertEq(rider.balance, before + 0.05 ether);
    }

    function test_TapOutAtOtherOperatorReverts() public {
        vm.startPrank(rider);
        t.deposit{value: 0.1 ether}();
        t.tapIn(op1, 1);
        vm.expectRevert("other operator");
        t.tapOut(op2, 1);
        vm.stopPrank();
        vm.prank(address(0xBEEF));
        vm.expectRevert("no open trip");
        t.tapOut(op1, 1);
    }

    function test_OnlyAdminAddsStation() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("not admin");
        t.addStation(op1, 9);
    }

    function test_PenaltyThenNotEnoughForNewTripReverts() public {
        vm.startPrank(rider);
        t.deposit{value: 0.06 ether}();
        t.tapIn(op1, 1);
        vm.expectRevert("balance < max fare");
        t.tapIn(op1, 2);
        vm.stopPrank();
        assertEq(t.pending(op1), 0);
    }

    function test_ClaimTwiceSecondPaysZero() public {
        vm.startPrank(rider);
        t.deposit{value: 0.1 ether}();
        t.tapIn(op1, 1);
        t.tapOut(op1, 3);
        vm.stopPrank();
        t.claim(op1);
        assertEq(payout1.balance, 0.025 ether);
        t.claim(op1);
        assertEq(payout1.balance, 0.025 ether);
    }

    function test_ClaimSumsAllShards() public {
        for (uint160 i = 1; i <= 20; i++) {
            address r = address(i * 0x1111);
            vm.deal(r, 1 ether);
            vm.startPrank(r);
            t.deposit{value: 0.1 ether}();
            t.tapIn(op1, 1);
            t.tapOut(op1, 2);
            vm.stopPrank();
        }
        assertEq(t.pending(op1), 20 * 0.015 ether);
        t.claim(op1);
        assertEq(payout1.balance, 20 * 0.015 ether);
        assertEq(t.pending(op1), 0);
    }

    // ---------------------------------------------------- stable unit (rate)

    function test_RateMovesFaresNotPrices() public {
        t.setRate(RATE * 2); // MON halves in value: the same ticket costs twice the MON
        assertEq(t.fare(op1, 0, 3), 0.05 ether);
        t.setRate(RATE / 2);
        assertEq(t.fare(op1, 0, 3), 0.0125 ether);
    }

    function test_OnlyOwnerSetsRate() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("not owner");
        t.setRate(1);
        vm.expectRevert("bad rate");
        t.setRate(0);
    }

    // ------------------------------------------------------ transfer discount

    function test_TransferSkipsBaseFareWithinWindow() public {
        vm.startPrank(rider);
        t.deposit{value: 0.5 ether}();
        t.tapIn(op1, 1);
        t.tapOut(op1, 2); // 10.00 + 1 x 5.00 = 15.00
        assertEq(t.pending(op1), 0.015 ether);

        skip(30 minutes);
        t.tapIn(op1, 1); // transfer
        t.tapOut(op1, 2); // 1 x 5.00 = 5.00 (no base)
        assertEq(t.pending(op1), 0.015 ether + 0.005 ether);

        skip(2 hours); // window over
        t.tapIn(op1, 1);
        t.tapOut(op1, 2);
        vm.stopPrank();
        assertEq(t.pending(op1), 0.035 ether);
    }

    function test_NoTransferAtOtherOperatorOrWhenDisabled() public {
        vm.startPrank(rider);
        t.deposit{value: 0.5 ether}();
        t.tapIn(op2, 1);
        t.tapOut(op2, 2); // Istanbul has no transfer window: 20.00 + 5 x 10 capped to 40.00
        t.tapIn(op2, 1);
        t.tapOut(op2, 2);
        assertEq(t.pending(op2), 0.08 ether);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ daily cap

    function test_DailyCapLimitsFares() public {
        vm.startPrank(rider);
        t.deposit{value: 2 ether}();
        // each Kizilay -> Cayyolu trip is 25.00; cap is 150.00 per day. Wait 2 h between trips so no transfer applies.
        for (uint256 i; i < 8; i++) {
            t.tapIn(op1, 1);
            t.tapOut(op1, 3);
            skip(2 hours);
        }
        vm.stopPrank();
        assertEq(t.pending(op1), 0.15 ether); // 6 full fares, then 0 once the cap is reached

        skip(1 days);
        vm.startPrank(rider);
        t.tapIn(op1, 1);
        t.tapOut(op1, 3);
        vm.stopPrank();
        assertEq(t.pending(op1), 0.175 ether); // a new day starts over
    }

    // -------------------------------------------------- time based max fare

    function test_TapOutAfterMaxTripChargesMaxFare() public {
        vm.startPrank(rider);
        t.deposit{value: 0.2 ether}();
        t.tapIn(op1, 1);
        skip(5 hours);
        t.tapOut(op1, 2); // would be 15.00, but the trip was left open
        vm.stopPrank();
        assertEq(t.pending(op1), 0.05 ether);
    }

    function test_ExpireClosesStaleTrip() public {
        vm.startPrank(rider);
        t.deposit{value: 0.2 ether}();
        t.tapIn(op1, 1);
        vm.stopPrank();

        vm.expectRevert("not expired");
        t.expire(rider);
        skip(4 hours + 1);
        vm.prank(address(0xBEEF)); // anyone can do it
        t.expire(rider);
        assertEq(t.pending(op1), 0.05 ether);
        assertEq(t.balances(rider), 0.15 ether);

        vm.expectRevert("no open trip");
        t.expire(rider);
    }

    // ----------------------------------------------------------------- pause

    function test_PauseBlocksNewTripsOnly() public {
        vm.startPrank(rider);
        t.deposit{value: 0.2 ether}();
        t.tapIn(op1, 1);
        vm.stopPrank();

        t.pause();
        vm.startPrank(rider);
        vm.expectRevert("paused");
        t.tapIn(op1, 2);
        t.tapOut(op1, 2); // riders can still leave
        t.withdraw(0.01 ether); // and take their money
        t.deposit{value: 0.01 ether}();
        vm.expectRevert("paused");
        t.tapIn(op1, 1);
        vm.stopPrank();

        t.unpause();
        vm.prank(rider);
        t.tapIn(op1, 1);
    }

    function test_OnlyOwnerPauses() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("not owner");
        t.pause();
    }

    // ---------------------------------------------------------------- refund

    function test_RefundMovesEarningsBackToRider() public {
        vm.startPrank(rider);
        t.deposit{value: 0.1 ether}();
        t.tapIn(op1, 1);
        t.tapOut(op1, 3);
        vm.stopPrank();
        assertEq(t.pending(op1), 0.025 ether);

        vm.prank(address(0xBEEF));
        vm.expectRevert("not admin");
        t.refund(op1, rider, 0.01 ether);

        t.refund(op1, rider, 0.01 ether);
        assertEq(t.pending(op1), 0.015 ether);
        assertEq(t.balances(rider), 0.075 ether + 0.01 ether);

        vm.expectRevert("not enough earnings");
        t.refund(op1, rider, 1 ether);
    }

    // ------------------------------------------------------------- depositFor

    function test_DepositForCreditsSomeoneElse() public {
        address other = address(0xCAFE);
        vm.prank(rider);
        t.depositFor{value: 0.3 ether}(other);
        assertEq(t.balances(other), 0.3 ether);
        assertEq(t.balances(rider), 0);
    }

    // ----------------------------------------------------- gas sponsorship

    uint256 constant PK = 0xA11CE5;

    function _req(uint8 action, uint32 op, uint32 station, uint256 amount, address to, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (Turnike.Req memory r)
    {
        r = Turnike.Req(vm.addr(PK), action, op, station, amount, to, nonce, deadline);
    }

    function _sign(Turnike.Req memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(PK, t.hashReq(r));
        return abi.encodePacked(rr, s, v);
    }

    function test_RelayTapsWithoutRiderGas() public {
        address signer = vm.addr(PK);
        assertEq(signer.balance, 0); // the rider never holds native MON
        t.depositFor{value: 0.2 ether}(signer);

        Turnike.Req memory a = _req(0, op1, 1, 0, address(0), 0, block.timestamp + 5 minutes);
        vm.prank(address(0xBEEF)); // relayer
        t.relay(a, _sign(a));
        (uint32 op,,,, bool open,,,) = t.trips(signer);
        assertTrue(open);
        assertEq(op, op1);
        assertEq(t.nonces(signer), 1);

        Turnike.Req memory b = _req(1, op1, 3, 0, address(0), 1, block.timestamp + 5 minutes);
        t.relay(b, _sign(b));
        assertEq(t.pending(op1), 0.025 ether);

        address dest = address(0xD00D);
        Turnike.Req memory w = _req(2, 0, 0, 0.1 ether, dest, 2, block.timestamp + 5 minutes);
        t.relay(w, _sign(w));
        assertEq(dest.balance, 0.1 ether);
        assertEq(t.nonces(signer), 3);
    }

    function test_RelayRejectsReplayExpiredAndWrongSigner() public {
        address signer = vm.addr(PK);
        t.depositFor{value: 0.2 ether}(signer);

        Turnike.Req memory a = _req(0, op1, 1, 0, address(0), 0, block.timestamp + 5 minutes);
        bytes memory sig = _sign(a);
        t.relay(a, sig);

        // replay of the same signed request
        vm.expectRevert("bad nonce");
        t.relay(a, sig);

        // expired
        Turnike.Req memory e = _req(1, op1, 3, 0, address(0), 1, block.timestamp - 1);
        bytes memory esig = _sign(e);
        vm.expectRevert("expired");
        t.relay(e, esig);

        // tampered request (different station) no longer matches the signature
        Turnike.Req memory ok = _req(1, op1, 2, 0, address(0), 1, block.timestamp + 5 minutes);
        bytes memory okSig = _sign(ok);
        ok.station = 3;
        vm.expectRevert("bad signature");
        t.relay(ok, okSig);

        // signed by somebody else
        Turnike.Req memory forged = _req(1, op1, 2, 0, address(0), 1, block.timestamp + 5 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, t.hashReq(forged));
        vm.expectRevert("bad signature");
        t.relay(forged, abi.encodePacked(r, s, v));

        // bad action / short signature
        Turnike.Req memory x = _req(9, 0, 0, 0, address(0), 1, block.timestamp + 5 minutes);
        bytes memory xsig = _sign(x);
        vm.expectRevert("bad action");
        t.relay(x, xsig);
        vm.expectRevert("bad signature");
        t.relay(x, hex"1234");
    }

    function test_RelayedTapRevertKeepsNonce() public {
        address signer = vm.addr(PK);
        // no balance: tapIn reverts, and the nonce is NOT consumed (the whole tx reverts)
        Turnike.Req memory a = _req(0, op1, 1, 0, address(0), 0, block.timestamp + 5 minutes);
        bytes memory sig = _sign(a);
        vm.expectRevert("balance < max fare");
        t.relay(a, sig);
        assertEq(t.nonces(signer), 0);

        t.depositFor{value: 0.1 ether}(signer);
        t.relay(a, sig); // the same signature works once the rider has funds
        assertEq(t.nonces(signer), 1);
    }
}
