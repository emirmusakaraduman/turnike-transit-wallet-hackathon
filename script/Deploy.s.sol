// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Turnike} from "../src/Turnike.sol";

contract Deploy is Script {
    // 1 fiat cent (TRY) = 0.00001 MON, so a 10.00 lira base fare is 0.01 MON on testnet.
    // Update with `setRate` as the MON price moves; it stands in for a price oracle.
    uint256 constant WEI_PER_CENT = 1e13;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        Turnike t = new Turnike(WEI_PER_CENT);

        // Ankara: base 10.00, per zone 5.00, max 50.00, daily cap 150.00, free-base transfer within 1 h
        // Stations: Kizilay (zone 0), Ulus (1), Cayyolu (3)
        uint32 a = t.registerOperator("Ankara", me, 1000, 500, 5000, 15000, 3600);
        t.addStation(a, 0);
        t.addStation(a, 1);
        t.addStation(a, 3);

        // Istanbul: base 20.00, per zone 10.00, max 80.00, daily cap 240.00, transfer within 90 min
        // Stations: Taksim (zone 0), Kadikoy (2), Levent (4)
        uint32 i = t.registerOperator("Istanbul", me, 2000, 1000, 8000, 24000, 5400);
        t.addStation(i, 0);
        t.addStation(i, 2);
        t.addStation(i, 4);
        vm.stopBroadcast();

        console.log("TURNIKE_ADDRESS", address(t));
    }
}
