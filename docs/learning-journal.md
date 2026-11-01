# Learning Journal — BACnet/IP Device Simulator

> A practical engineering notebook for understanding, commissioning and extending this BACnet/IP irrigation-device simulator. This document records what was implemented and observed in this testbed; it is not a substitute for the BACnet standard or a product conformance statement.

## 1. Project purpose

This repository implements an independent BACnet/IP server that represents one simulated irrigation process. Its responsibility is to expose process values and accept BACnet commands. It deliberately does not contain the Web SCADA HMI, database or SCADA-side BACnet client.

The separation is important: the device simulator can be commissioned with a generic BACnet browser such as YABE before it is connected to a supervisory application.

## 2. Runtime architecture

```text
src/process.js  ->  process state and irrigation logic
       |
       v
src/device.js   ->  BACnet device object, object database and services
       |
       | BACnet/IP over UDP
       v
YABE or another BACnet client
       |
       +---- Web SCADA BACnet driver (separate repository)
```

- `config.js`: device instance, UDP endpoint, vendor identifier, update period and object definitions.
- `process.js`: process state, command validation, permissives and one-second simulation tick.
- `device.js`: BACnet object representation, Who-Is/I-Am, ReadProperty, ReadPropertyMultiple and WriteProperty handling.

The process model is kept independent of the BACnet protocol layer. This makes it possible to test process behavior without sending network requests.

## 3. BACnet/IP network configuration

| Parameter | Development default | Notes |
|---|---:|---|
| Device instance | 10005 | BACnet Device object instance |
| UDP port | 47809 | Non-default port selected to avoid local collision |
| Bind interface | 0.0.0.0 | Listen on available IPv4 interfaces |
| Vendor ID | 999 | Project/testbed identifier; not a registered product identity |
| Process tick | 1000 ms | Simulation update interval |

BACnet/IP commonly uses UDP 47808. This testbed uses UDP 47809 because another BACnet component on the same development host uses 47808. A client must address the actual simulator IP and UDP port. Broadcast discovery across non-default ports, routed networks or VLANs may require additional network configuration; do not assume a local broadcast will cross a router.

### Network commissioning checklist

1. Confirm the simulator host IP address.
2. Confirm that the process is listening on UDP 47809.
3. Confirm host firewall rules allow the required UDP traffic.
4. Configure YABE or the client with the correct target address and port.
5. Capture traffic if discovery or confirmed services fail:
   ```bash
   sudo ss -lunp | grep 47809
   sudo tcpdump -ni any 'udp port 47809 or udp port 47808'
   ```
6. Test device discovery and property reads before testing writes.
7. Test writes at a known priority and inspect the resulting process state.

## 4. Object model

| Object | Instance | Name | Meaning | Access |
|---|---:|---|---|---|
| Device | 10005 | Zone05-BACnet-Simulator | Device identity and object list | Read |
| Analog Input | 1 | Zone05_Moisture | Soil moisture, % | Read |
| Analog Input | 2 | Zone05_Flow | Flow, gpm | Read |
| Analog Input | 3 | Zone05_ValvePosition | Valve position, % | Read |
| Analog Input | 4 | Zone05_TankLevel | Tank level, % | Read |
| Binary Input | 1 | Zone05_PumpRunning | Pump running state | Read |
| Binary Input | 2 | Zone05_PumpFault | Pump fault state | Read |
| Binary Output | 1 | Zone05_AutoMode | AUTO / MANUAL selection | Commandable |
| Binary Output | 2 | Zone05_StartRequest | Momentary start request | Commandable |
| Binary Output | 3 | Zone05_StopRequest | Momentary stop request | Commandable |
| Binary Output | 4 | Zone05_FaultReset | Momentary reset request | Commandable |

Analog values use BACnet REAL application values. Flow is expressed in gallons per minute; moisture, valve position and tank level are percentages. Binary values are represented numerically as inactive (0) and active (1).

The simulator implements a 16-slot Priority_Array and Relinquish_Default for its Binary Output objects. The effective command is resolved from the highest-priority (lowest-numbered) non-NULL slot. A write at a priority changes that slot; writing BACnet NULL relinquishes the slot. The testbed's SCADA driver uses priority 8.

## 5. Process model and control behavior

Current demonstration parameters:

| Parameter | Value |
|---|---:|
| Initial mode | AUTO |
| Initial moisture | 56% |
| AUTO start threshold | 30% |
| AUTO stop threshold | 55% |
| Initial tank level | 78% |
| Minimum tank level for start permissive | 20% |
| Simulated flow while running | 4.9 gpm |
| Process update interval | 1 second |

Behavior:
- In AUTO, the pump starts when moisture reaches or falls below 30%, provided the permissive is satisfied.
- In AUTO, the pump stops when moisture reaches or exceeds 55%.
- In MANUAL, START is accepted only when there is no fault and tank level is at least 20%.
- STOP stops the pump and sets a stop inhibit. In AUTO, this prevents automatic restart until AUTO is selected again.
- While running, valve position is 100%, flow is 4.9 gpm, moisture rises and tank level falls.
- While stopped, flow and valve position are zero and moisture slowly decreases.
- Fault Reset clears the fault state; it does not start the pump.

These are illustrative simulation parameters, not tuned irrigation settings. The current model starts without a fault and does not yet expose a fault-injection mechanism.

## 6. BACnet services and interoperability notes

The implementation handles these request paths:

- **Who-Is / I-Am:** device discovery and identity response.
- **ReadProperty:** reads a stored property from the selected object.
- **ReadPropertyMultiple (RPM):** returns requested properties. The BACnet ALL property request must be expanded into the object's individual stored properties rather than treated as a normal property identifier.
- **WriteProperty:** accepts Present_Value writes to the configured Binary Output objects and rejects unsupported writes.

A BACnet array uses one-based element indexing; index 0 is used to obtain the array length. An ALL array index requests the complete array. These details matter for properties such as Object_List and Priority_Array.

The request handlers use the server-side event interface exposed by the installed `node-bacnet` package. Verify behavior against the exact library version in `package-lock.json`; library server-side APIs may have different maturity and support levels from client APIs.

## 7. Commissioning with YABE

Recommended order:

1. Discover the device and verify instance 10005.
2. Read Device Object properties, including Object_Name, Vendor_Identifier and Object_List.
3. Read AI1–AI4 Present_Value and confirm plausible process values and units.
4. Read BI1–BI2 Present_Value.
5. Read BO1 Present_Value and inspect Priority_Array / Relinquish_Default where supported.
6. Test MANUAL mode, then START, then STOP.
7. Return to AUTO and observe the moisture thresholds.
8. Test unsupported writes and confirm the simulator rejects them.

### Manual command sequence

For a manual pump test, write the following values at priority 8:

| Sequence | Object | Value | Expected behavior |
|---|---|---|---|
| 1 | BO1 | INACTIVE | Select MANUAL |
| 2 | BO2 | ACTIVE | Start request; pump runs if permissive is true |
| 3 | BO2 | INACTIVE or relinquish | Clear the request slot; pump remains running |
| 4 | BO3 | ACTIVE | Stop pump and inhibit automatic restart |
| 5 | BO3 | INACTIVE or relinquish | Clear the request slot; pump remains stopped in MANUAL |
| 6 | BO1 | ACTIVE | Return to AUTO; automatic logic resumes |

START and STOP are action requests. Their active transition invokes the process command; clearing the BACnet command slot does not undo the action. This is why the SCADA driver pulses the command and then clears its slot.

## 8. Observed validation in this testbed

The following activities have been reported as completed during development:

- YABE device discovery and I-Am response.
- Object_List read.
- Analog Input Present_Value reads.
- ReadPropertyMultiple, including ALL-property handling.
- Binary Output writes and visible process-state changes.
- Web SCADA BACnet driver reading seven mapped observations.
- Zone 05 values displayed through the SCADA API/HMI.
- AUTO/MANUAL, START and STOP command behavior exercised.
- Combined test of Web SCADA Zones 02, 03, 04 and 05 reported successful.

These are development test observations. A full BACnet conformance test, interoperability matrix across vendors, routed BBMD test and physical field validation have not been established by these results.

## 9. Troubleshooting notes

| Symptom | Check |
|---|---|
| Device not discovered | IP address, UDP port 47809, firewall, broadcast domain and client port configuration |
| Discovery works but property read fails | Confirm ReadProperty handler, object identifier, property identifier and response encoding |
| RPM ALL returns no properties | Expand ALL into the object's property entries |
| Object_List or Priority_Array appears incomplete | Check BACnet array index semantics: 0 for length, 1..N for elements, ALL for full array |
| Writes are rejected | Confirm object is a configured BO, property is Present_Value, value is valid and priority is 1–16 |
| START is rejected | Confirm MANUAL mode, no active fault and tank level >= 20% |
| YABE shows no response after host migration | Confirm the new simulator IP and target UDP port |
| Tcpdump reports bad UDP checksum | Consider NIC checksum offloading before treating this as packet corruption; compare with capture from another point or disable offload for diagnosis |

## 10. Known limitations and next experiments

- No fault injection or simulated fault cause is currently implemented.
- No physical sensor, valve, pump or safety circuit is connected.
- Vendor ID 999 is a project identifier, not evidence of BACnet International vendor registration.
- The default UDP port is non-standard and may need explicit client configuration.
- No BBMD/routed BACnet/IP deployment has been validated.
- No authentication or network security layer is provided by this simulator itself.

Suggested next work:
1. Add deterministic fault injection and test Fault Reset.
2. Add unit tests for process thresholds, permissives, command transitions and stop inhibit.
3. Add tests for invalid object/property requests and BACnet array behavior.
4. Verify the server with a second independent BACnet client.
5. Document packet captures and exact YABE test steps for reproducibility.
6. Add a configurable device name and process parameters if multiple simulator instances are needed.

## 11. Change log

| Date / milestone | Engineering note |
|---|---|
| Initial implementation | Separated process model from BACnet object database and added BACnet/IP server behavior |
| YABE commissioning | Corrected ReadProperty and ReadPropertyMultiple ALL handling |
| SCADA integration | Connected a separate Node.js BACnet client driver to this device |
| Diagnostics refinement | Kept command and process-transition logs while reducing repetitive polling output |

## References

- [BACnet overview — ASHRAE](https://www.ashrae.org/technical-resources/bookstore/bacnet)
- [BACnet International](https://bacnetinternational.org/)
- [node-bacnet package](https://www.npmjs.com/package/node-bacnet)
- [YABE — Yet Another BACnet Explorer](https://sourceforge.net/projects/yetanotherbacnetexplorer/)

---
*Update this journal when behavior, configuration, test evidence or engineering decisions change. Prefer recording reproducible observations and exact software versions over assumptions.*
