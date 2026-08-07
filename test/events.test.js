import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrame } from '../src/homeconnect/events.js';
import { SETTINGS, STATUSES } from '../src/homeconnect/constants.js';

test('parseFrame expands the items of a STATUS frame into one event each', () => {
  const frame = [
    'event: STATUS',
    `data: {"items":[{"key":"${STATUSES.DOOR_STATE}","value":"BSH.Common.EnumType.DoorState.Open","timestamp":1737000000},{"key":"${STATUSES.OPERATION_STATE}","value":"BSH.Common.EnumType.OperationState.Run"}],"haId":"BOSCH-HCS03DWH-1"}`,
    'id: BOSCH-HCS03DWH-1',
  ].join('\n');

  const events = parseFrame(frame);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    haId: 'BOSCH-HCS03DWH-1',
    type: 'STATUS',
    key: STATUSES.DOOR_STATE,
    value: 'BSH.Common.EnumType.DoorState.Open',
    unit: undefined,
  });
  assert.equal(events[1].key, STATUSES.OPERATION_STATE);
});

test('parseFrame drops KEEP-ALIVE frames', () => {
  assert.deepEqual(parseFrame('event: KEEP-ALIVE\ndata: ""\n'), []);
});

test('parseFrame falls back to the SSE id when the payload carries no haId', () => {
  const events = parseFrame('event: DISCONNECTED\ndata: ""\nid: SIEMENS-HCS05FRF-9');
  assert.deepEqual(events, [{ haId: 'SIEMENS-HCS05FRF-9', type: 'DISCONNECTED' }]);
});

test('parseFrame ignores a frame that identifies no appliance', () => {
  assert.deepEqual(parseFrame('event: STATUS\ndata: {"items":[]}'), []);
});

test('parseFrame keeps the unit of a NOTIFY item', () => {
  const frame = `event: NOTIFY\ndata: {"haId":"X-1","items":[{"key":"${SETTINGS.FRIDGE_SETPOINT}","value":4,"unit":"°C"}]}`;
  assert.deepEqual(parseFrame(frame), [
    { haId: 'X-1', type: 'NOTIFY', key: SETTINGS.FRIDGE_SETPOINT, value: 4, unit: '°C' },
  ]);
});

test('parseFrame survives an unparsable payload instead of throwing', () => {
  assert.deepEqual(parseFrame('event: STATUS\ndata: {not json}\nid: X-1'), [
    { haId: 'X-1', type: 'STATUS' },
  ]);
});

test('parseFrame handles CRLF line endings and multi-line data', () => {
  const frame = 'event: STATUS\r\ndata: {"haId":"X-1",\r\ndata: "items":[]}\r\n';
  assert.deepEqual(parseFrame(frame), [{ haId: 'X-1', type: 'STATUS' }]);
});
