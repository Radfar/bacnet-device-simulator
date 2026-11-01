require('dotenv').config();
const Bacnet = require('node-bacnet');
const processModel = require('./process');
const {
  DEVICE_INSTANCE, BACNET_PORT, BACNET_INTERFACE, VENDOR_ID, TICK_MS, OBJECTS
} = require('./config');

const client = new Bacnet({ port: BACNET_PORT, interface: BACNET_INTERFACE });
const PV = Bacnet.enum.PropertyIdentifier.PRESENT_VALUE;
const PT = Bacnet.enum.PropertyIdentifier;
const OT = Bacnet.enum.ObjectType;
const AT = Bacnet.enum.ApplicationTag;

const objectList = [
  { type: OT.DEVICE, instance: DEVICE_INSTANCE },
  ...Object.values(OBJECTS).map(({ type, instance }) => ({ type, instance })),
];

function appValue(value, type) {
  return [{ type, value }];
}

function makeObject(name, type, value, extra = {}) {
  return {
    [PT.OBJECT_NAME]: appValue(name, AT.CHARACTER_STRING),
    [PT.OBJECT_IDENTIFIER]: appValue({ type: extra.objectType, instance: extra.instance }, AT.OBJECTIDENTIFIER),
    [PT.OBJECT_TYPE]: appValue(extra.objectType, AT.ENUMERATED),
    [PT.PRESENT_VALUE]: appValue(value, type),
    [PT.DESCRIPTION]: appValue(name.replaceAll('_', ' '), AT.CHARACTER_STRING),
    ...extra.properties,
  };
}

const db = {
  [OT.DEVICE]: {
    [DEVICE_INSTANCE]: {
      [PT.OBJECT_NAME]: appValue('Zone05-BACnet-Simulator', AT.CHARACTER_STRING),
      [PT.OBJECT_IDENTIFIER]: appValue({ type: OT.DEVICE, instance: DEVICE_INSTANCE }, AT.OBJECTIDENTIFIER),
      [PT.OBJECT_TYPE]: appValue(OT.DEVICE, AT.ENUMERATED),
      [PT.VENDOR_IDENTIFIER]: appValue(VENDOR_ID, AT.UNSIGNED_INTEGER),
      [PT.VENDOR_NAME]: appValue('Radfar Portfolio', AT.CHARACTER_STRING),
      [PT.MODEL_NAME]: appValue('Zone 05 Irrigation Simulator', AT.CHARACTER_STRING),
      [PT.DESCRIPTION]: appValue('Independent simulated irrigation BACnet device', AT.CHARACTER_STRING),
      [PT.FIRMWARE_REVISION]: appValue('0.1.0', AT.CHARACTER_STRING),
      [PT.APPLICATION_SOFTWARE_VERSION]: appValue('0.1.0', AT.CHARACTER_STRING),
      [PT.PROTOCOL_VERSION]: appValue(1, AT.UNSIGNED_INTEGER),
      [PT.PROTOCOL_REVISION]: appValue(14, AT.UNSIGNED_INTEGER),
      [PT.SYSTEM_STATUS]: appValue(0, AT.ENUMERATED),
      [PT.MAX_APDU_LENGTH_ACCEPTED]: appValue(1476, AT.UNSIGNED_INTEGER),
      [PT.SEGMENTATION_SUPPORTED]: appValue(3, AT.ENUMERATED),
      [PT.OBJECT_LIST]: objectList.map(value => ({ type: AT.OBJECTIDENTIFIER, value })),
    },
  },
};

function addObject(type, instance, object) {
  db[type] ||= {};
  db[type][instance] = object;
}

const initial = processModel.snapshot();
addObject(OT.ANALOG_INPUT, 1, makeObject('Zone05_Moisture', AT.REAL, initial.moisture, { objectType: OT.ANALOG_INPUT, instance: 1, properties: { [PT.UNITS]: appValue(98, AT.ENUMERATED) } }));
addObject(OT.ANALOG_INPUT, 2, makeObject('Zone05_Flow', AT.REAL, initial.flow, { objectType: OT.ANALOG_INPUT, instance: 2, properties: { [PT.UNITS]: appValue(76, AT.ENUMERATED) } }));
addObject(OT.ANALOG_INPUT, 3, makeObject('Zone05_ValvePosition', AT.REAL, initial.valvePosition, { objectType: OT.ANALOG_INPUT, instance: 3, properties: { [PT.UNITS]: appValue(98, AT.ENUMERATED) } }));
addObject(OT.ANALOG_INPUT, 4, makeObject('Zone05_TankLevel', AT.REAL, initial.tankLevel, { objectType: OT.ANALOG_INPUT, instance: 4, properties: { [PT.UNITS]: appValue(98, AT.ENUMERATED) } }));
addObject(OT.BINARY_INPUT, 1, makeObject('Zone05_PumpRunning', AT.ENUMERATED, 0, { objectType: OT.BINARY_INPUT, instance: 1 }));
addObject(OT.BINARY_INPUT, 2, makeObject('Zone05_PumpFault', AT.ENUMERATED, 0, { objectType: OT.BINARY_INPUT, instance: 2 }));

const priorityArrays = new Map();

function addCommandObject(instance, name, commandName) {
  const obj = makeObject(name, AT.ENUMERATED, commandName === 'auto' ? 1 : 0, {
    objectType: OT.BINARY_OUTPUT,
    instance,
    properties: {
      [PT.PRIORITY_ARRAY]: Array.from({ length: 16 }, () => ({ type: AT.NULL, value: null })),
      [PT.RELINQUISH_DEFAULT]: appValue(commandName === 'auto' ? 1 : 0, AT.ENUMERATED),
    },
  });
  addObject(OT.BINARY_OUTPUT, instance, obj);
  priorityArrays.set(instance, { commandName, slots: obj[PT.PRIORITY_ARRAY], defaultValue: commandName === 'auto' ? 1 : 0, resolved: commandName === 'auto' ? 1 : 0 });
}
addCommandObject(1, 'Zone05_AutoMode', 'auto');
addCommandObject(2, 'Zone05_StartRequest', 'start');
addCommandObject(3, 'Zone05_StopRequest', 'stop');
addCommandObject(4, 'Zone05_FaultReset', 'faultreset');

function objectFor(objectId) {
  return db[objectId.type]?.[objectId.instance] || null;
}

function sendError(data, service, errorClass, errorCode) {
  client.errorResponse(data.header.sender, service, data.invokeId, errorClass, errorCode);
}

// Capture requests that node-bacnet decodes but cannot route to a registered service listener.
client.on('unhandledEvent', data => {

});

client.on('whoIs', data => {
  client.iAmResponse(data.header.sender, DEVICE_INSTANCE, Bacnet.enum.Segmentation.NO_SEGMENTATION, VENDOR_ID);
  console.log('[Zone05 BACnet] I-Am sent to', data.header.sender.address);
});

// node-bacnet server-side request events are marked beta in the library documentation.
// These handlers follow the same event/response API used by the existing Zone 03 gateway.
client.on('readProperty', data => {
  const { objectId, property } = data.payload;

  const obj = objectFor(objectId);
  if (!obj) {
    console.warn('[Zone05 BACnet] Unknown object:', objectId);
    return sendError(data, Bacnet.enum.ConfirmedServiceChoice.READ_PROPERTY, Bacnet.enum.ErrorClass.OBJECT, Bacnet.enum.ErrorCode.UNKNOWN_OBJECT);
  }

  if (!Object.prototype.hasOwnProperty.call(obj, property.id)) {
    console.warn('[Zone05 BACnet] Unknown property:', property.id, 'for object:', objectId);
    return sendError(data, Bacnet.enum.ConfirmedServiceChoice.READ_PROPERTY, Bacnet.enum.ErrorClass.PROPERTY, Bacnet.enum.ErrorCode.UNKNOWN_PROPERTY);
  }

  const value = obj[property.id];
  client.readPropertyResponse(data.header.sender, data.invokeId, objectId, property, value);
});

// ReadPropertyMultiple returns one result entry per requested object.
// BACnet property ALL (8) is a request modifier: expand it into the object's
// individual properties rather than looking up property ID 8 in the object map.
function readPropertyMultipleValue(objectId, property) {
  const obj = objectFor(objectId);
  if (!obj) {
    return [{
      type: AT.CONTEXT_SPECIFIC_DECODED,
      value: {
        type: 'BacnetError',
        errorClass: Bacnet.enum.ErrorClass.OBJECT,
        errorCode: Bacnet.enum.ErrorCode.UNKNOWN_OBJECT,
      },
    }];
  }

  const stored = obj[property.id];
  if (!stored) {
    return [{
      type: AT.CONTEXT_SPECIFIC_DECODED,
      value: {
        type: 'BacnetError',
        errorClass: Bacnet.enum.ErrorClass.PROPERTY,
        errorCode: Bacnet.enum.ErrorCode.UNKNOWN_PROPERTY,
      },
    }];
  }

  const arrayAll = Bacnet.enum.ASN1_ARRAY_ALL;
  if (property.index === undefined || property.index === arrayAll) return stored;

  // BACnet array index 0 returns the array length; indexes 1..N are one-based.
  if (property.index === 0) {
    return [{ type: AT.UNSIGNED_INTEGER, value: stored.length }];
  }
  const item = stored[property.index - 1];
  if (item === undefined) {
    return [{
      type: AT.CONTEXT_SPECIFIC_DECODED,
      value: {
        type: 'BacnetError',
        errorClass: Bacnet.enum.ErrorClass.PROPERTY,
        errorCode: Bacnet.enum.ErrorCode.INVALID_ARRAY_INDEX,
      },
    }];
  }
  return [item];
}

function readPropertyMultipleEntries(objectId, requestedProperty) {
  const obj = objectFor(objectId);
  const allPropertyId = Bacnet.enum.PropertyIdentifier.ALL;
  const arrayAll = Bacnet.enum.ASN1_ARRAY_ALL;

  if (requestedProperty.id === allPropertyId && obj) {
    return Object.entries(obj).map(([propertyId, stored]) => ({
      property: { id: Number(propertyId), index: arrayAll },
      value: stored,
    }));
  }

  return [{
    property: { id: requestedProperty.id, index: requestedProperty.index },
    value: readPropertyMultipleValue(objectId, requestedProperty),
  }];
}

client.on('readPropertyMultiple', data => {
  const requestedObjects = data.payload.properties || [];
  const results = requestedObjects.map(({ objectId, properties = [] }) => ({
    objectId,
    values: properties.flatMap(property => readPropertyMultipleEntries(objectId, property)),
  }));

  client.readPropertyMultipleResponse(data.header.sender, data.invokeId, results);
});

function resolvedValue(entry) {
  for (let i = 0; i < 16; i++) {
    if (entry.slots[i].type !== AT.NULL) return Number(entry.slots[i].value);
  }
  return entry.defaultValue;
}

client.on('writeProperty', data => {
  const { objectId, value: writeData } = data.payload;
  const { property, value, priority } = writeData;
  const isPresentValueWrite =
    objectId.type === OT.BINARY_OUTPUT &&
    property.id === PT.PRESENT_VALUE &&
    priorityArrays.has(objectId.instance);

  if (!isPresentValueWrite || !value?.length) {
    return sendError(data, Bacnet.enum.ConfirmedServiceChoice.WRITE_PROPERTY, Bacnet.enum.ErrorClass.PROPERTY, Bacnet.enum.ErrorCode.WRITE_ACCESS_DENIED);
  }

  const entry = priorityArrays.get(objectId.instance);
  const writePriority = priority || 16;
  if (writePriority < 1 || writePriority > 16) {
    return sendError(data, Bacnet.enum.ConfirmedServiceChoice.WRITE_PROPERTY, Bacnet.enum.ErrorClass.PROPERTY, Bacnet.enum.ErrorCode.VALUE_OUT_OF_RANGE);
  }

  const previous = entry.resolved;
  const relinquish = value[0].type === AT.NULL;
  entry.slots[writePriority - 1] = relinquish
    ? { type: AT.NULL, value: null }
    : { type: value[0].type, value: value[0].value };

  const next = resolvedValue(entry);
  entry.resolved = next;
  const obj = objectFor(objectId);
  obj[PV][0].value = next;

  try {
    if (next !== previous) {
      if (entry.commandName === 'auto') {
        processModel.command(next ? 'auto' : 'manual');
      } else if (next) {
        processModel.command(entry.commandName);
      }
    }
    client.simpleAckResponse(data.header.sender, Bacnet.enum.ConfirmedServiceChoice.WRITE_PROPERTY, data.invokeId);
    const commandLabel = {
      auto: next ? 'AUTO mode' : 'MANUAL mode',
      start: 'START request',
      stop: 'STOP request',
      faultreset: 'FAULT RESET request',
    }[entry.commandName] || entry.commandName;
    const commandState = next ? 'ACTIVE' : 'INACTIVE';
    const processState = processModel.snapshot();
    console.log(
      `[Zone05 COMMAND] ${commandLabel} | BO:${objectId.instance} | ${commandState}${relinquish ? ' (priority relinquished)' : ''} | Priority: ${writePriority} | From: ${data.header.sender.address}`
    );
    console.log(
      `[Zone05 PROCESS] Mode=${processState.mode} | Pump=${processState.pumpRunning ? 'RUNNING' : 'STOPPED'} | Flow=${processState.flow.toFixed(1)} gpm | Valve=${processState.valvePosition}% | Moisture=${processState.moisture.toFixed(1)}% | Tank=${processState.tankLevel.toFixed(1)}% | Fault=${processState.fault ? 'ACTIVE' : 'CLEAR'}`
    );
  } catch (error) {
    // Restore the effective BACnet command state when the process rejects it.
    entry.slots[writePriority - 1] = { type: AT.NULL, value: null };
    entry.resolved = previous;
    obj[PV][0].value = previous;
    sendError(data, Bacnet.enum.ConfirmedServiceChoice.WRITE_PROPERTY, Bacnet.enum.ErrorClass.DEVICE, Bacnet.enum.ErrorCode.OPERATIONAL_PROBLEM);
    console.warn('[Zone05 BACnet] command rejected:', error.message);
  }
});

let lastProcessLog = null;

function logProcessTransitions(state) {
  const current = {
    mode: state.mode,
    pumpRunning: state.pumpRunning,
    fault: state.fault,
    permissive: state.permissive,
  };

  if (!lastProcessLog) {
    lastProcessLog = current;
    return;
  }

  if (current.mode !== lastProcessLog.mode) {
    console.log(`[Zone05 PROCESS] Operating mode changed: ${lastProcessLog.mode} -> ${current.mode}`);
  }
  if (current.pumpRunning !== lastProcessLog.pumpRunning) {
    console.log(`[Zone05 PROCESS] Pump ${current.pumpRunning ? 'STARTED' : 'STOPPED'} | Flow=${state.flow.toFixed(1)} gpm | Valve=${state.valvePosition}%`);
  }
  if (current.fault !== lastProcessLog.fault) {
    console.log(`[Zone05 ALARM] Fault ${current.fault ? 'ACTIVE' : 'CLEARED'}`);
  }
  if (current.permissive !== lastProcessLog.permissive) {
    console.log(`[Zone05 PROCESS] Start permissive: ${current.permissive ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
  }

  lastProcessLog = current;
}

function syncObjects() {
  const state = processModel.tick();
  logProcessTransitions(state);
  const set = (type, instance, value) => {
    db[type][instance][PV][0].value = value;
  };
  set(OT.ANALOG_INPUT, 1, Number(state.moisture.toFixed(2)));
  set(OT.ANALOG_INPUT, 2, Number(state.flow.toFixed(2)));
  set(OT.ANALOG_INPUT, 3, Number(state.valvePosition.toFixed(1)));
  set(OT.ANALOG_INPUT, 4, Number(state.tankLevel.toFixed(2)));
  set(OT.BINARY_INPUT, 1, state.pumpRunning ? 1 : 0);
  set(OT.BINARY_INPUT, 2, state.fault ? 1 : 0);
}

syncObjects();
const timer = setInterval(syncObjects, TICK_MS);

console.log('');
console.log('============================================================');
console.log(' ZONE 05 | BACnet/IP IRRIGATION DEVICE SIMULATOR');
console.log('============================================================');
console.log(` Device instance : ${DEVICE_INSTANCE}`);
console.log(` UDP endpoint    : ${BACNET_INTERFACE}:${BACNET_PORT}`);
console.log(` Vendor ID       : ${VENDOR_ID}`);
console.log(` Process update  : every ${TICK_MS} ms`);
console.log('------------------------------------------------------------');
console.log('[READY] Waiting for BACnet Who-Is, ReadProperty, RPM and WriteProperty requests');
console.log('[INFO] Command writes and process-state transitions will be shown below.');
console.log('============================================================');
console.log('');

function shutdown() {
  clearInterval(timer);
  try { client.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
