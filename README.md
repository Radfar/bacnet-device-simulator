# BACnet Device Simulator

An independent BACnet/IP device simulator for the Industrial Water Management / Building Irrigation SCADA testbed.

This repository contains the simulated BACnet device and its process model. It does **not** contain the Web SCADA backend, HMI, database, or SCADA-side BACnet client.

## Architecture

```text
BACnet Device Simulator
  ├── Process model (irrigation state and logic)
  └── BACnet/IP server (device and BACnet objects)
             │
             │ BACnet/IP over UDP
             ▼
       SCADA BACnet client
             │
             ▼
       Node.js SCADA backend
```

The simulator is independently runnable. The SCADA application communicates with it as a BACnet/IP client.

## Requirements

- Node.js 22 or later
- npm
- Network connectivity between the simulator host and BACnet client
- A BACnet/IP browser such as YABE for commissioning and diagnostics

## Installation

Clone the repository and install its dependencies:

```bash
git clone https://github.com/Radfar/bacnet-device-simulator.git
cd bacnet-device-simulator
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Edit `.env` if you need to change the device instance, UDP port, or bind interface.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `ZONE05_BACNET_DEVICE_INSTANCE` | `10005` | BACnet Device object instance |
| `ZONE05_BACNET_PORT` | `47809` | BACnet/IP UDP listening port |
| `ZONE05_BACNET_INTERFACE` | `0.0.0.0` | Local interface to bind |

The simulator uses UDP port **47809** by default. BACnet/IP commonly uses UDP 47808; this project uses 47809 to avoid a same-host port collision with another local BACnet/IP service. A BACnet client must target the simulator's IP address and UDP port explicitly. Broadcast discovery across non-standard ports may require explicit client configuration or a routed BBMD arrangement.

## Run

Start the simulator:

```bash
npm start
```

Expected startup messages:

```text
[Zone05 BACnet] Device 10005 listening on 0.0.0.0:47809/UDP
[Zone05 BACnet] Independent process simulation started
```

Stop it with `Ctrl+C`.

## BACnet object map

| Process point | BACnet object | Instance | Access |
|---|---|---:|---|
| Soil moisture | Analog Input | 1 | Read |
| Flow | Analog Input | 2 | Read |
| Valve position | Analog Input | 3 | Read |
| Tank level | Analog Input | 4 | Read |
| Pump running | Binary Input | 1 | Read |
| Pump fault | Binary Input | 2 | Read |
| Auto / Manual mode | Binary Output | 1 | Write |
| Start request | Binary Output | 2 | Write |
| Stop request | Binary Output | 3 | Write |
| Fault reset | Binary Output | 4 | Write |

Binary Output commands are represented as commandable objects with priority arrays. Monitoring objects are read-only.

## Process model

- Initial mode: AUTO
- Initial soil moisture: 56%
- AUTO starts watering at or below 30% moisture.
- AUTO stops watering at or above 55% moisture.
- Manual START is accepted only in MANUAL mode, with no fault and tank level at least 20%.
- STOP prevents automatic restart until AUTO is selected again.
- Simulated flow while watering: 4.9 gpm.
- Tank level and soil moisture change during the simulation.

These are demonstration values, not field-calibrated control parameters. The simulator currently initializes with no active fault; fault-injection functionality is not yet provided.

## Commissioning and diagnostics

1. Start the simulator and confirm the startup messages.
2. Confirm the UDP listener on the host:
   ```bash
   sudo ss -lunp | grep 47809
   ```
3. Capture BACnet/IP traffic:
   ```bash
   sudo tcpdump -ni any 'udp port 47809 or udp port 47808'
   ```
4. Configure the BACnet client to use the simulator host IP and UDP port 47809.
5. Verify device discovery, Object List, Present_Value reads, and Binary Output writes independently before integrating the SCADA client.

**Development status:** this is an initial migrated implementation. BACnet discovery has been observed in the development environment, but ReadProperty interoperability with YABE remains under investigation. Do not treat successful discovery alone as proof that all BACnet services are working.

## Repository structure

```text
bacnet-device-simulator/
├── src/
│   ├── config.js
│   ├── device.js
│   └── process.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## License

MIT. See [LICENSE](LICENSE).
