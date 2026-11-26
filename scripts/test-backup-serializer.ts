/**
 * Standalone Automated Synthetic Test Suite for Hardened Lossless Backup Engine (P0.2.1-R2)
 * Khalid Pharmacy Management System
 */

import {
  canonicalJsonStringify,
  computeBackupChecksum,
  verifyBackupChecksum,
  KhalidPharmacyBackupV1,
} from '../src/services/backupFormat.js';

import {
  serializeLossless,
  deserializeLossless,
  isValidBase64Canonical,
  computeBase64DecodedByteLength,
  ThreePassDeserializer,
  EnvelopeNode,
  DEFAULT_DESERIALIZER_LIMITS,
} from '../src/services/backupSerializer.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
  }
}

function assertThrows(
  fn: () => void,
  testName: string,
  expectedSubstring: string
) {
  totalTests++;
  try {
    fn();
    failedTests++;
    console.error(`  [FAIL] ${testName} - Expected error containing "${expectedSubstring}", but no error was thrown.`);
  } catch (err: any) {
    if (typeof err.message === 'string' && err.message.includes(expectedSubstring)) {
      passedTests++;
      console.log(`  [PASS] ${testName} (Caught expected: "${expectedSubstring}")`);
    } else {
      failedTests++;
      console.error(
        `  [FAIL] ${testName} - Threw unexpected error: "${err.message}", expected substring: "${expectedSubstring}"`
      );
    }
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('      P0.2.1-R2 HARDENED BACKUP SERIALIZER SYNTHETIC TESTS       ');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // SUITE 1: Date Serialization (Valid Dates & Invalid Date Support)
  // -------------------------------------------------------------------------
  console.log('--- Suite 1: Date Serialization (Valid & Invalid Date) ---');

  const validDate = new Date('2026-11-11T06:00:00.000Z');
  const invalidDate = new Date(NaN);

  const synthDates = { valid: validDate, invalid: invalidDate };
  const serializedDates = serializeLossless(synthDates);
  const deserializedDates = deserializeLossless(serializedDates.rootRef, serializedDates.nodes);

  assert(deserializedDates.valid instanceof Date, 'Suite 1.1: Valid Date instance restored');
  assert(deserializedDates.valid.toISOString() === '2026-11-11T06:00:00.000Z', 'Suite 1.2: Valid Date exact ISO string preserved');
  assert(deserializedDates.invalid instanceof Date, 'Suite 1.3: Invalid Date instance restored');
  assert(Number.isNaN(deserializedDates.invalid.getTime()), 'Suite 1.4: Invalid Date time value is strictly NaN');

  // -------------------------------------------------------------------------
  // SUITE 2: Built-in Extra Properties on All Required Types
  // (Date, RegExp, Map, Set, DataView, ArrayBuffer, TypedArrays)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 2: Extra Properties on Built-in Types ---');

  // Date with extra property
  const dateWithProp = new Date('2026-01-01T00:00:00.000Z');
  (dateWithProp as any).fiscalQuarter = 'Q1-2026';

  // RegExp with extra property
  const regexWithProp = /inventory_\d+/g;
  regexWithProp.lastIndex = 3;
  (regexWithProp as any).category = 'SKU_REGEX';

  // Map with extra property
  const mapWithProp = new Map<string, string>();
  mapWithProp.set('itemA', 'Amoxicillin');
  (mapWithProp as any).auditVersion = 'v1.2';

  // Set with extra property
  const setWithProp = new Set<string>();
  setWithProp.add('batch_101');
  (setWithProp as any).clusterId = 'EAST_WAREHOUSE';

  // ArrayBuffer with extra property
  const rawBuf = new ArrayBuffer(8);
  (rawBuf as any).checksumHeader = '0xABCD';

  // DataView with extra property
  const dvWithProp = new DataView(rawBuf, 0, 8);
  (dvWithProp as any).viewOwner = 'FINANCE_REPORT';

  // TypedArray with extra property
  const taWithProp = new Uint32Array(rawBuf, 0, 2);
  taWithProp[0] = 777;
  (taWithProp as any).ledgerCode = 'LEDGER_MAIN';

  const synthExtraProps = {
    d: dateWithProp,
    r: regexWithProp,
    m: mapWithProp,
    s: setWithProp,
    ab: rawBuf,
    dv: dvWithProp,
    ta: taWithProp,
  };

  const serializedEP = serializeLossless(synthExtraProps);
  const deserializedEP = deserializeLossless(serializedEP.rootRef, serializedEP.nodes);

  assert((deserializedEP.d as any).fiscalQuarter === 'Q1-2026', 'Suite 2.1: Date extra property restored');
  assert((deserializedEP.r as any).category === 'SKU_REGEX', 'Suite 2.2: RegExp extra property restored');
  assert(deserializedEP.r.lastIndex === 3, 'Suite 2.3: RegExp lastIndex preserved alongside extra property');
  assert((deserializedEP.m as any).auditVersion === 'v1.2', 'Suite 2.4: Map extra property restored');
  assert(deserializedEP.m.get('itemA') === 'Amoxicillin', 'Suite 2.5: Map entry preserved with extra property');
  assert((deserializedEP.s as any).clusterId === 'EAST_WAREHOUSE', 'Suite 2.6: Set extra property restored');
  assert(deserializedEP.s.has('batch_101'), 'Suite 2.7: Set item preserved with extra property');
  assert((deserializedEP.ab as any).checksumHeader === '0xABCD', 'Suite 2.8: ArrayBuffer extra property restored');
  assert((deserializedEP.dv as any).viewOwner === 'FINANCE_REPORT', 'Suite 2.9: DataView extra property restored');
  assert((deserializedEP.ta as any).ledgerCode === 'LEDGER_MAIN', 'Suite 2.10: TypedArray extra property restored');
  assert(deserializedEP.ta.buffer === deserializedEP.ab, 'Suite 2.11: Shared buffer identity preserved across views with extra props');

  // -------------------------------------------------------------------------
  // SUITE 3: Circular References Inside Map, Set, and Extra Properties
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 3: Circular References in Map, Set & Extra Properties ---');

  const circularMap = new Map<any, any>();
  const circularHolder: any = { tag: 'MAP_CIRCULAR_HOLDER' };
  circularMap.set('selfRef', circularMap); // Map references itself
  circularMap.set('holder', circularHolder);
  circularHolder.parentMap = circularMap;

  const circularSet = new Set<any>();
  circularSet.add(circularSet); // Set references itself

  // Circular reference inside extra properties
  const dateCycle: any = new Date('2026-05-01T00:00:00.000Z');
  const cycleObj: any = { name: 'DateCycleObject' };
  dateCycle.refToObj = cycleObj;
  cycleObj.backToDate = dateCycle;

  const synthCirc = { m: circularMap, s: circularSet, d: dateCycle };
  const serializedCirc = serializeLossless(synthCirc);
  const deserializedCirc = deserializeLossless(serializedCirc.rootRef, serializedCirc.nodes);

  assert(deserializedCirc.m.get('selfRef') === deserializedCirc.m, 'Suite 3.1: Circular Map self-reference restored');
  assert(deserializedCirc.m.get('holder').parentMap === deserializedCirc.m, 'Suite 3.2: Circular Map-Object cycle restored');
  assert(deserializedCirc.s.has(deserializedCirc.s), 'Suite 3.3: Circular Set self-reference restored');
  assert(deserializedCirc.d.refToObj.backToDate === deserializedCirc.d, 'Suite 3.4: Circular Object-Date extra property cycle restored');

  // -------------------------------------------------------------------------
  // SUITE 4: Memory Protection — ArrayBuffer Bounds & Cumulative Binary Limits
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 4: Memory Protection & Early Buffer Bounds Audits ---');

  // 4.1 Single ArrayBuffer exceeding maxArrayBufferSize
  const hugeBufferNode: EnvelopeNode[] = [
    {
      '@': 1,
      t: 'ArrayBuffer',
      b: 'AAAA', // dummy
      l: 60 * 1024 * 1024, // 60MB exceeds default 50MB limit
    },
  ];
  const customDeserializerLimits = new ThreePassDeserializer({
    maxArrayBufferSize: 1024 * 1024, // Set small 1MB limit for synthetic test
  });
  assertThrows(
    () => customDeserializerLimits.deserialize({ '#': 1 }, hugeBufferNode),
    'Suite 4.1: Reject ArrayBuffer exceeding maxArrayBufferSize in Pass 1',
    'exceeds maximum buffer limit'
  );

  // 4.2 Cumulative binary size exceeding maxTotalBinarySize
  const validB64_600 = 'AAAA'.repeat(200);
  const cumulativeBufferNodes: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: validB64_600, l: 600 },
    { '@': 2, t: 'ArrayBuffer', b: validB64_600, l: 600 }, // Total = 1200 bytes
  ];
  const smallTotalDeserializer = new ThreePassDeserializer({
    maxArrayBufferSize: 1000,
    maxTotalBinarySize: 1000, // Total cumulative limit 1000 bytes
  });
  assertThrows(
    () => smallTotalDeserializer.deserialize({ '#': 1 }, cumulativeBufferNodes),
    'Suite 4.2: Reject cumulative binary size exceeding maxTotalBinarySize in Pass 1',
    'Total cumulative binary size'
  );

  // -------------------------------------------------------------------------
  // SUITE 5: Memory Protection — Node Count Limits
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 5: Memory Protection — Node Count Limits ---');

  const manyNodes: EnvelopeNode[] = [];
  for (let i = 1; i <= 15; i++) {
    manyNodes.push({ '@': i, t: 'Object', p: {} });
  }
  const strictNodeDeserializer = new ThreePassDeserializer({
    maxNodeCount: 10, // Limit to 10 nodes
  });
  assertThrows(
    () => strictNodeDeserializer.deserialize({ '#': 1 }, manyNodes),
    'Suite 5.1: Reject payload exceeding maxNodeCount in Pass 1',
    'Node count (15) exceeds maximum limit'
  );

  // -------------------------------------------------------------------------
  // SUITE 6: Array Length Limits & Envelope Elements Integrity
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 6: Array Length Limits & Envelope Elements Integrity ---');

  // 6.1 Array length exceeding maxArrayLength
  const hugeArrayNode: EnvelopeNode[] = [
    { '@': 1, t: 'Array', l: 50, e: new Array(50).fill(1) },
  ];
  const strictArrayDeserializer = new ThreePassDeserializer({
    maxArrayLength: 20,
  });
  assertThrows(
    () => strictArrayDeserializer.deserialize({ '#': 1 }, hugeArrayNode),
    'Suite 6.1: Reject Array exceeding maxArrayLength in Pass 1',
    'exceeds maximum allowed limit'
  );

  // 6.2 Array Envelope Integrity Mismatch: declared length !== elements array length
  const mismatchArrayNode: EnvelopeNode[] = [
    { '@': 1, t: 'Array', l: 5, e: [1, 2, 3] }, // Declared 5, but elements has 3!
  ];
  const standardDeserializer = new ThreePassDeserializer();
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 1 }, mismatchArrayNode),
    'Suite 6.2: Reject Array when elements array length does not match declared length',
    'does not match declared length'
  );

  // -------------------------------------------------------------------------
  // SUITE 7: Dangerous Properties & Prototype Pollution Prevention
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 7: Dangerous Properties & Prototype Pollution Prevention ---');

  // 7.1 Serialization rejection of dangerous properties
  const protoPollutionObject = Object.create(null);
  Object.defineProperty(protoPollutionObject, '__proto__', {
    value: { isAdmin: true },
    enumerable: true,
  });
  assertThrows(
    () => serializeLossless(protoPollutionObject),
    'Suite 7.1: Serializer explicitly rejects own __proto__ property',
    'Prototype manipulation attempt blocked'
  );

  // 7.2 Deserialization Pass 1 rejection of __proto__
  const evilProtoEnvelope: EnvelopeNode[] = [
    {
      '@': 1,
      t: 'Object',
      p: JSON.parse('{"__proto__": {"admin": true}}'),
    },
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 1 }, evilProtoEnvelope),
    'Suite 7.2: Deserializer Pass 1 rejects __proto__ property in envelope',
    'Security Violation: Dangerous property \'__proto__\' detected'
  );

  // 7.3 Deserialization Pass 1 rejection of constructor property
  const evilConstructorEnvelope: EnvelopeNode[] = [
    {
      '@': 1,
      t: 'Object',
      p: {
        'constructor': { polluted: true },
      },
    },
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 1 }, evilConstructorEnvelope),
    'Suite 7.3: Deserializer Pass 1 rejects constructor property in envelope',
    'Security Violation: Dangerous property \'constructor\' detected'
  );

  // 7.4 Deserialization Pass 1 rejection of prototype property
  const evilPrototypeEnvelope: EnvelopeNode[] = [
    {
      '@': 1,
      t: 'Object',
      p: {
        'prototype': { polluted: true },
      },
    },
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 1 }, evilPrototypeEnvelope),
    'Suite 7.4: Deserializer Pass 1 rejects prototype property in envelope',
    'Security Violation: Dangerous property \'prototype\' detected'
  );

  // -------------------------------------------------------------------------
  // SUITE 8: Sparse Arrays vs Undefined Preservation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 8: Sparse Arrays vs Undefined Preservation ---');

  const sparseWithUndef: any[] = [];
  sparseWithUndef[0] = 'first';
  sparseWithUndef[1] = undefined; // Explicitly defined with undefined
  // index 2 is an empty hole!
  sparseWithUndef[3] = 'fourth';
  sparseWithUndef.length = 5; // index 4 is also an empty hole

  const serializedSparse = serializeLossless(sparseWithUndef);
  const deserializedSparse = deserializeLossless(serializedSparse.rootRef, serializedSparse.nodes);

  assert(Array.isArray(deserializedSparse), 'Suite 8.1: Restored as Array');
  assert(deserializedSparse.length === 5, 'Suite 8.2: Array restored with exact length 5');
  assert(0 in deserializedSparse && deserializedSparse[0] === 'first', 'Suite 8.3: Index 0 is present with value');
  assert(1 in deserializedSparse && deserializedSparse[1] === undefined, 'Suite 8.4: Index 1 is PRESENT with value undefined');
  assert(!(2 in deserializedSparse), 'Suite 8.5: Index 2 is an EMPTY HOLE (2 in arr === false)');
  assert(3 in deserializedSparse && deserializedSparse[3] === 'fourth', 'Suite 8.6: Index 3 is present with value');
  assert(!(4 in deserializedSparse), 'Suite 8.7: Index 4 is an EMPTY HOLE (4 in arr === false)');

  // -------------------------------------------------------------------------
  // SUITE 9: TypedArray Boundaries, Alignment & Reserved Properties
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 9: TypedArray Boundaries, Alignment & Reserved Properties ---');

  // 9.1 Misaligned byteOffset rejection
  const misalignedNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: 'AAAAAAAAAAAAAAAAAAAAAA==', l: 16 },
    { '@': 2, t: 'Uint32Array', b: { '#': 1 }, o: 2, l: 2 }, // Uint32 requires 4-byte alignment, 2 is misaligned
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 2 }, misalignedNode),
    'Suite 9.1: Reject Uint32Array with misaligned byteOffset in Pass 1',
    'is not aligned to element size 4'
  );

  // 9.2 Buffer bounds overflow rejection
  const overflowNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: 'AAAAAA==', l: 4 }, // 4 bytes
    { '@': 2, t: 'Float64Array', b: { '#': 1 }, o: 0, l: 1 }, // 1 Float64 requires 8 bytes!
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 2 }, overflowNode),
    'Suite 9.2: Reject Float64Array requiring more bytes than buffer byteLength',
    'Buffer bounds overflow'
  );

  // 9.3 Reserved property overwrite collision rejection
  const reservedTaNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: 'AAAAAA==', l: 4 },
    { '@': 2, t: 'Uint8Array', b: { '#': 1 }, o: 0, l: 4, p: { slice: 'COLLISION' } },
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 2 }, reservedTaNode),
    'Suite 9.3: Reject property collision with reserved TypedArray method',
    'collides with reserved built-in property'
  );

  // 9.4 Numeric index collision in extra properties map rejection
  const indexCollisionNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: 'AAAAAA==', l: 4 },
    { '@': 2, t: 'Uint8Array', b: { '#': 1 }, o: 0, l: 4, p: { '2': 'COLLISION_WITH_INDEX' } },
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 2 }, indexCollisionNode),
    'Suite 9.4: Reject extra property colliding with element index',
    'collides with element index'
  );

  // -------------------------------------------------------------------------
  // SUITE 10: Canonical JSON & Numeric Keys Determinism
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 10: Canonical JSON & Numeric Keys Determinism ---');

  const objOrderA = {
    '10': 'ten',
    '2': 'two',
    'beta': 'b',
    'alpha': 'a',
    '0': 'zero',
  };

  const objOrderB = {
    'alpha': 'a',
    '0': 'zero',
    'beta': 'b',
    '2': 'two',
    '10': 'ten',
  };

  const canonicalA = canonicalJsonStringify(objOrderA);
  const canonicalB = canonicalJsonStringify(objOrderB);

  assert(canonicalA === canonicalB, 'Suite 10.1: canonicalJsonStringify output identical regardless of insertion order');
  assert(
    canonicalA === '{"0":"zero","10":"ten","2":"two","alpha":"a","beta":"b"}',
    'Suite 10.2: Keys strictly sorted by UTF-16 code units (RFC 8785)'
  );

  // -------------------------------------------------------------------------
  // SUITE 11: Checksum Tampering & Non-Circular Verification
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 11: Checksum Tampering & Non-Circular Verification ---');

  const testBackup: Omit<KhalidPharmacyBackupV1, 'checksum'> = {
    header: {
      version: '1.0',
      appId: 'com.khalidpharmacy.app',
      format: 'KP_BACKUP_V1',
      createdAt: '2026-11-11T06:00:00.000Z',
      generator: 'KP-Backup-Test-P0.2.1-R2',
    },
    schema: {
      dbVersion: 4,
      stores: [
        { storeName: 'medicines', recordCount: 1, payloadChecksum: 'a1b2c3d4' },
      ],
    },
    payload: {
      medicines: {
        rootRef: { '#': 1 },
        nodes: [{ '@': 1, t: 'Object', p: { code: 'MED-1', stock: 50 } }],
      },
    },
  };

  const initialChecksum = await computeBackupChecksum(testBackup);
  assert(typeof initialChecksum === 'string' && initialChecksum.length === 64, 'Suite 11.1: 64-char hex SHA-256 computed');

  const fullBackupWithChecksum: KhalidPharmacyBackupV1 = {
    ...testBackup,
    checksum: initialChecksum,
  };

  const nonCircularChecksum = await computeBackupChecksum(fullBackupWithChecksum);
  assert(nonCircularChecksum === initialChecksum, 'Suite 11.2: Checksum computation strictly excludes checksum field (non-circular)');

  const isValidUntouched = await verifyBackupChecksum(fullBackupWithChecksum);
  assert(isValidUntouched === true, 'Suite 11.3: Verification passes on untouched backup');

  // Tamper Header
  const tamperedHeader: KhalidPharmacyBackupV1 = JSON.parse(JSON.stringify(fullBackupWithChecksum));
  tamperedHeader.header.appId = 'com.fake.app' as any;
  assert((await verifyBackupChecksum(tamperedHeader)) === false, 'Suite 11.4: Tampering header is detected');

  // Tamper Schema
  const tamperedSchema: KhalidPharmacyBackupV1 = JSON.parse(JSON.stringify(fullBackupWithChecksum));
  tamperedSchema.schema.dbVersion = 5;
  assert((await verifyBackupChecksum(tamperedSchema)) === false, 'Suite 11.5: Tampering schema is detected');

  // Tamper Payload
  const tamperedPayload: KhalidPharmacyBackupV1 = JSON.parse(JSON.stringify(fullBackupWithChecksum));
  tamperedPayload.payload.medicines.nodes[0].p.stock = 9999;
  assert((await verifyBackupChecksum(tamperedPayload)) === false, 'Suite 11.6: Tampering payload is detected');

  // -------------------------------------------------------------------------
  // SUITE 12: Comprehensive Lossless Round-Trip Integrity for All 13 Types
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 12: Comprehensive Lossless Round-Trip Integrity ---');

  const comprehensiveGraph: any = {
    undef: undefined,
    big: BigInt('123456789012345678901234567890'),
    nan: NaN,
    inf: Infinity,
    negInf: -Infinity,
    negZero: -0,
    validDate: new Date('2026-11-11T00:00:00.000Z'),
    invalidDate: new Date(NaN),
    regex: /batch-[A-Z0-9]+/gi,
    map: new Map<any, any>([
      ['key1', 'val1'],
      [{ id: 'objKey' }, { id: 'objVal' }],
    ]),
    set: new Set<any>([10, 'text', { id: 'setItem' }]),
    rawBuffer: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer,
    nullObj: Object.create(null),
    sparseArr: [1, , 3],
  };

  comprehensiveGraph.regex.lastIndex = 4;
  comprehensiveGraph.nullObj.specialKey = 'null-proto-val';
  (comprehensiveGraph.sparseArr as any).customArrayTag = 'SPARSE_TAG';

  const sharedBuf = comprehensiveGraph.rawBuffer;
  comprehensiveGraph.views = {
    i8: new Int8Array(sharedBuf, 0, 8),
    u8: new Uint8Array(sharedBuf, 0, 8),
    u8c: new Uint8ClampedArray(sharedBuf, 0, 8),
    i16: new Int16Array(sharedBuf, 0, 4),
    u16: new Uint16Array(sharedBuf, 0, 4),
    i32: new Int32Array(sharedBuf, 0, 2),
    u32: new Uint32Array(sharedBuf, 0, 2),
    f32: new Float32Array(sharedBuf, 0, 2),
    f64: new Float64Array(sharedBuf, 0, 1),
    bi64: new BigInt64Array(sharedBuf, 0, 1),
    bu64: new BigUint64Array(sharedBuf, 0, 1),
    dv: new DataView(sharedBuf, 0, 8),
  };

  comprehensiveGraph.selfRef = comprehensiveGraph;

  const roundTripSerialized = serializeLossless(comprehensiveGraph);
  const roundTripRestored = deserializeLossless(roundTripSerialized.rootRef, roundTripSerialized.nodes);

  assert(roundTripRestored.undef === undefined, 'Suite 12.1: undefined round-trip');
  assert(roundTripRestored.big === BigInt('123456789012345678901234567890'), 'Suite 12.2: BigInt round-trip');
  assert(Number.isNaN(roundTripRestored.nan), 'Suite 12.3: NaN round-trip');
  assert(roundTripRestored.inf === Infinity, 'Suite 12.4: Infinity round-trip');
  assert(roundTripRestored.negInf === -Infinity, 'Suite 12.5: -Infinity round-trip');
  assert(Object.is(roundTripRestored.negZero, -0), 'Suite 12.6: -0 round-trip');
  assert(roundTripRestored.validDate.toISOString() === '2026-11-11T00:00:00.000Z', 'Suite 12.7: Valid Date round-trip');
  assert(Number.isNaN(roundTripRestored.invalidDate.getTime()), 'Suite 12.8: Invalid Date round-trip');
  assert(roundTripRestored.regex.source === 'batch-[A-Z0-9]+' && roundTripRestored.regex.lastIndex === 4, 'Suite 12.9: RegExp round-trip');
  assert(roundTripRestored.map instanceof Map && roundTripRestored.map.get('key1') === 'val1', 'Suite 12.10: Map round-trip');
  assert(roundTripRestored.set instanceof Set && roundTripRestored.set.has(10), 'Suite 12.11: Set round-trip');
  assert(roundTripRestored.rawBuffer instanceof ArrayBuffer, 'Suite 12.12: ArrayBuffer round-trip');
  assert(roundTripRestored.views.i32.buffer === roundTripRestored.rawBuffer, 'Suite 12.13: Buffer sharing preserved across TypedArrays');
  assert(roundTripRestored.views.dv.buffer === roundTripRestored.rawBuffer, 'Suite 12.14: Buffer sharing preserved for DataView');
  assert(Object.getPrototypeOf(roundTripRestored.nullObj) === null, 'Suite 12.15: Null prototype preserved');
  assert(roundTripRestored.nullObj.specialKey === 'null-proto-val', 'Suite 12.16: Null prototype properties preserved');
  assert(!(1 in roundTripRestored.sparseArr) && roundTripRestored.sparseArr.customArrayTag === 'SPARSE_TAG', 'Suite 12.17: Sparse array hole & extra prop preserved');
  assert(roundTripRestored.selfRef === roundTripRestored, 'Suite 12.18: Root circular self-reference preserved');

  // -------------------------------------------------------------------------
  // SUITE 13: R2 — Nested Payload Resource Limits (Inline Strings & Depth Limits)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 13: R2 — Nested Payload Resource Limits (Inline Strings & Depth) ---');

  const strictR2LimitsDeserializer = new ThreePassDeserializer({
    maxStringLength: 100,      // Small string limit for testing
    maxRecursionDepth: 5,      // Small depth limit for testing
  });

  // 13.1 Reject huge string in Array element
  const hugeStringArrayNode: EnvelopeNode[] = [
    { '@': 1, t: 'Array', l: 1, e: ['X'.repeat(150)] },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringArrayNode),
    'Suite 13.1: Reject inline string in Array element exceeding maxStringLength in Pass 1',
    'String length (150) exceeds maximum limit (100)'
  );

  // 13.2 Reject huge string in Object property value
  const hugeStringObjNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { description: 'Y'.repeat(200) } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringObjNode),
    'Suite 13.2: Reject inline string in Object property value exceeding maxStringLength in Pass 1',
    'String length (200) exceeds maximum limit (100)'
  );

  // 13.3 Reject huge string in Map key or value
  const hugeStringMapNodeKey: EnvelopeNode[] = [
    { '@': 1, t: 'Map', e: [['K'.repeat(120), 'normalVal']] },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringMapNodeKey),
    'Suite 13.3: Reject inline string in Map entry key exceeding maxStringLength in Pass 1',
    'String length (120) exceeds maximum limit (100)'
  );

  const hugeStringMapNodeVal: EnvelopeNode[] = [
    { '@': 1, t: 'Map', e: [['normalKey', 'V'.repeat(130)]] },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringMapNodeVal),
    'Suite 13.4: Reject inline string in Map entry value exceeding maxStringLength in Pass 1',
    'String length (130) exceeds maximum limit (100)'
  );

  // 13.4 Reject huge string in Set element
  const hugeStringSetNode: EnvelopeNode[] = [
    { '@': 1, t: 'Set', e: ['S'.repeat(110)] },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringSetNode),
    'Suite 13.5: Reject inline string in Set element exceeding maxStringLength in Pass 1',
    'String length (110) exceeds maximum limit (100)'
  );

  // 13.5 Reject huge property key string
  const hugeKeyNameNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { ['P'.repeat(105)]: 'val' } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeKeyNameNode),
    'Suite 13.6: Reject property key string length exceeding maxStringLength in Pass 1',
    'Property key length (105) exceeds maximum string limit (100)'
  );

  // 13.6 Reject deeply nested inline object structure exceeding maxRecursionDepth
  // Build an inline nested object structure 8 levels deep (exceeds maxRecursionDepth = 5)
  let deepInlineObj: any = { level: 8 };
  for (let d = 7; d >= 1; d--) {
    deepInlineObj = { child: deepInlineObj };
  }
  const deepInlineNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { nested: deepInlineObj } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, deepInlineNode),
    'Suite 13.7: Reject inline nested payload exceeding maxRecursionDepth (5) in Pass 1',
    'Exceeded maximum allowed recursion depth (5)'
  );

  // -------------------------------------------------------------------------
  // SUITE 14: R2 — Legitimate Deep & Complex Nested Payload Round-Trip
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 14: R2 — Legitimate Nested Payloads Round-Trip ---');

  // Build a legitimate nested object structure 15 levels deep (default limit = 100)
  let legitNested: any = { status: 'DEEP_LEAF_OK', value: 42 };
  for (let level = 14; level >= 1; level--) {
    legitNested = { levelName: `LEVEL_${level}`, inner: legitNested };
  }

  const serializedLegit = serializeLossless(legitNested);
  const deserializedLegit = deserializeLossless(serializedLegit.rootRef, serializedLegit.nodes);

  // Extract leaf at depth 15
  let curr = deserializedLegit;
  for (let level = 1; level <= 14; level++) {
    assert(curr.levelName === `LEVEL_${level}`, `Suite 14.1: Level ${level} resolved`);
    curr = curr.inner;
  }
  assert(curr.status === 'DEEP_LEAF_OK' && curr.value === 42, 'Suite 14.2: Deep leaf at level 15 accurately restored');

  // Complex legitimate inline collection containing Map/Set/Array with normal string lengths
  const complexLegitObj = {
    storeName: 'Central Pharmacy Warehouse',
    metadata: {
      tags: ['REFRIGERATED', 'CONTROLLED_SUBSTANCE'],
      mapInfo: new Map<string, any>([
        ['batchPrefix', 'BAT-2026'],
        ['limits', { maxStock: 5000, reorderPoint: 500 }],
      ]),
    },
  };

  const serializedComplex = serializeLossless(complexLegitObj);
  const deserializedComplex = deserializeLossless(serializedComplex.rootRef, serializedComplex.nodes);

  assert(deserializedComplex.storeName === 'Central Pharmacy Warehouse', 'Suite 14.3: Top-level string restored');
  assert(deserializedComplex.metadata.tags[0] === 'REFRIGERATED', 'Suite 14.4: Nested array element restored');
  assert(deserializedComplex.metadata.mapInfo.get('batchPrefix') === 'BAT-2026', 'Suite 14.5: Nested Map entry restored');
  assert(deserializedComplex.metadata.mapInfo.get('limits').maxStock === 5000, 'Suite 14.6: Nested object inside Map restored');

  // -------------------------------------------------------------------------
  // SUITE 15: Targeted Coverage Verification & Envelope Node Integrity
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 15: Targeted Coverage Verification of node.p, node.e & Ref Scans ---');

  // 15.1 Rejection of extraneous properties in envelope reference '#'
  const smuggledRefPayload: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { ref: { '#': 2, 'smuggledKey': 'evilPayload' } } },
    { '@': 2, t: 'Object', p: { status: 'OK' } },
  ];
  assertThrows(
    () => standardDeserializer.deserialize({ '#': 1 }, smuggledRefPayload),
    'Suite 15.1: Reject envelope reference containing extraneous properties in Pass 1',
    'Envelope reference contains extraneous properties'
  );

  // 15.2 Huge string in node.p of TypedArray
  const hugeStringTypedArrayNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: 'AAAA', l: 3 },
    { '@': 2, t: 'Uint8Array', b: { '#': 1 }, o: 0, l: 3, p: { customMeta: 'M'.repeat(150) } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 2 }, hugeStringTypedArrayNode),
    'Suite 15.2: Reject inline string in TypedArray extra property exceeding maxStringLength in Pass 1',
    'String length (150) exceeds maximum limit (100)'
  );

  // 15.3 Huge string in node.p of Date
  const hugeStringDateNode: EnvelopeNode[] = [
    { '@': 1, t: 'Date', v: '2026-01-01T00:00:00.000Z', p: { note: 'D'.repeat(150) } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringDateNode),
    'Suite 15.3: Reject inline string in Date extra property exceeding maxStringLength in Pass 1',
    'String length (150) exceeds maximum limit (100)'
  );

  // 15.4 Huge string in node.p of ArrayBuffer
  const hugeStringArrayBufferNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: 'AAAA', l: 3, p: { headerMeta: 'B'.repeat(150) } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, hugeStringArrayBufferNode),
    'Suite 15.4: Reject inline string in ArrayBuffer extra property exceeding maxStringLength in Pass 1',
    'String length (150) exceeds maximum limit (100)'
  );

  // 15.5 Deep nesting inside node.e of Array (exceeding maxRecursionDepth = 5)
  let deepInArray: any = 'LEAF';
  for (let i = 0; i < 7; i++) {
    deepInArray = [deepInArray];
  }
  const deepArrayNode: EnvelopeNode[] = [
    { '@': 1, t: 'Array', l: 1, e: [deepInArray] },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, deepArrayNode),
    'Suite 15.5: Reject deep nesting inside Array elements exceeding maxRecursionDepth in Pass 1',
    'Exceeded maximum allowed recursion depth (5)'
  );

  // 15.6 Referenced node is independently validated in Pass 1 (cannot bypass checks via '#')
  // Root references node 1, which references node 2, which has a huge string in node.p
  const refChainWithHugeString: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { next: { '#': 2 } } },
    { '@': 2, t: 'Object', p: { deepProperty: 'H'.repeat(250) } },
  ];
  assertThrows(
    () => strictR2LimitsDeserializer.deserialize({ '#': 1 }, refChainWithHugeString),
    'Suite 15.6: Referencing a node via "#" does not bypass Pass 1 validation of target node',
    'String length (250) exceeds maximum limit (100)'
  );

  // 15.7 Legitimate shared DAG references across nodes and inline structures
  const sharedMeta = { category: 'ANALGESIC', shelf: 'B-12' };
  const dagGraph = {
    firstRecord: { info: sharedMeta, count: 10 },
    secondRecord: { info: sharedMeta, count: 20 },
    inventoryList: [sharedMeta, sharedMeta],
  };
  const serializedDAG = serializeLossless(dagGraph);
  const deserializedDAG = deserializeLossless(serializedDAG.rootRef, serializedDAG.nodes);

  assert(deserializedDAG.firstRecord.info.category === 'ANALGESIC', 'Suite 15.7: DAG shared structure restored');
  assert(deserializedDAG.firstRecord.info === deserializedDAG.secondRecord.info, 'Suite 15.8: DAG reference identity preserved');
  assert(deserializedDAG.inventoryList[0] === deserializedDAG.firstRecord.info, 'Suite 15.9: DAG array reference identity preserved');

  // -------------------------------------------------------------------------
  // SUITE 16: R2 Final — Node Envelope Direct String Limits (BigInt, RegExp, Error, ArrayBuffer)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 16: R2 Final — Node Envelope Direct String Limits ---');

  const envelopeStringLimitsDeserializer = new ThreePassDeserializer({
    maxStringLength: 100,            // Small string limit for testing direct fields
    maxBase64StringLength: 120,      // Independent Base64 limit
  });

  // 16.1 Negative: BigInt with node.v exceeding maxStringLength rejected in Pass 1 before format check
  const hugeBigIntPrimitiveNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { bigVal: { t: 'BigInt', v: '9'.repeat(150) } } },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeBigIntPrimitiveNode),
    'Suite 16.1: Reject BigInt primitive string exceeding maxStringLength in Pass 1 before format check',
    'BigInt string length (150) exceeds maximum limit (100)'
  );

  // 16.2 Negative: BigInt as direct envelope node exceeding maxStringLength
  const hugeBigIntDirectNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: {} },
    { t: 'BigInt', v: '1'.repeat(150) },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeBigIntDirectNode),
    'Suite 16.2: Reject BigInt envelope node exceeding maxStringLength in Pass 1',
    'BigInt string length (150) exceeds maximum limit (100)'
  );

  // 16.3 Negative: BigInt with non-string node.v rejected in Pass 1
  const nonStringBigIntNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: {} },
    { t: 'BigInt', v: 12345 as any },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, nonStringBigIntNode),
    'Suite 16.3: Reject non-string BigInt envelope value in Pass 1',
    'BigInt envelope missing string value'
  );

  // 16.4 Positive: Valid BigInt within maxStringLength accepted
  const validBigIntNode: EnvelopeNode[] = [
    { '@': 1, t: 'Object', p: { bigVal: { t: 'BigInt', v: '9876543210123456789' } } },
  ];
  const validBigIntResult = envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, validBigIntNode);
  assert(
    validBigIntResult.bigVal === BigInt('9876543210123456789'),
    'Suite 16.4: Valid BigInt string within maxStringLength accepted and deserialized accurately'
  );

  // 16.5 Negative: RegExp source pattern exceeding maxStringLength rejected in Pass 1 before compilation
  const hugeRegexSourceNode: EnvelopeNode[] = [
    { '@': 1, t: 'RegExp', s: 'a'.repeat(150), f: 'i' },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeRegexSourceNode),
    'Suite 16.5: Reject RegExp source pattern exceeding maxStringLength in Pass 1',
    'RegExp envelope pattern length (150) exceeds maximum limit (100)'
  );

  // 16.6 Negative: RegExp missing required source string 's' rejected in Pass 1
  const missingRegexSourceNode: EnvelopeNode[] = [
    { '@': 1, t: 'RegExp', f: 'g' },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, missingRegexSourceNode),
    'Suite 16.6: Reject RegExp missing source string "s" in Pass 1',
    "RegExp envelope missing source string 's'"
  );

  // 16.7 Negative: RegExp flags exceeding limit rejected in Pass 1
  const hugeRegexFlagsNode: EnvelopeNode[] = [
    { '@': 1, t: 'RegExp', s: 'test', f: 'g'.repeat(55) },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeRegexFlagsNode),
    'Suite 16.7: Reject RegExp flags exceeding allowed limit in Pass 1',
    'RegExp envelope flags length exceeds allowed limits'
  );

  // 16.8 Positive: Valid RegExp within limits accepted and properly compiled
  const validRegexNode: EnvelopeNode[] = [
    { '@': 1, t: 'RegExp', s: '^batch-[0-9]+$', f: 'i', i: 0 },
  ];
  const validRegexResult = envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, validRegexNode);
  assert(
    validRegexResult instanceof RegExp && validRegexResult.test('batch-456'),
    'Suite 16.8: Valid RegExp within limits accepted and operational'
  );

  // 16.9 Positive: Valid RegExp with "s" and "f" fields accepted
  const validRegexMultNode: EnvelopeNode[] = [
    { '@': 1, t: 'RegExp', s: 'sku_[a-z]+', f: 'm' },
  ];
  const validRegexMultResult = envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, validRegexMultNode);
  assert(
    validRegexMultResult instanceof RegExp && validRegexMultResult.source === 'sku_[a-z]+' && validRegexMultResult.flags === 'm',
    'Suite 16.9: Valid RegExp with "s" and "f" fields accepted and deserialized accurately'
  );

  // 16.10 Negative: Error node message exceeding maxStringLength rejected in Pass 1
  const hugeErrorMessageNode: EnvelopeNode[] = [
    { '@': 1, t: 'Error', message: 'E'.repeat(150), name: 'DatabaseError' },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeErrorMessageNode),
    'Suite 16.10: Reject Error envelope message exceeding maxStringLength in Pass 1',
    'Error envelope message length (150) exceeds maximum limit (100)'
  );

  // 16.11 Negative: Error node name exceeding maxStringLength rejected in Pass 1
  const hugeErrorNameNode: EnvelopeNode[] = [
    { '@': 1, t: 'Error', message: 'Critical failure', name: 'N'.repeat(150) },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeErrorNameNode),
    'Suite 16.11: Reject Error envelope name exceeding maxStringLength in Pass 1',
    'Error envelope name length (150) exceeds maximum limit (100)'
  );

  // 16.12 Negative: Error node stack exceeding maxStringLength rejected in Pass 1
  const hugeErrorStackNode: EnvelopeNode[] = [
    { '@': 1, t: 'Error', message: 'Failure', stack: 'S'.repeat(150) },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeErrorStackNode),
    'Suite 16.12: Reject Error envelope stack exceeding maxStringLength in Pass 1',
    'Error envelope stack length (150) exceeds maximum limit (100)'
  );

  // 16.13 Positive: Valid Error node within limits accepted
  const validErrorNode: EnvelopeNode[] = [
    { '@': 1, t: 'Error', message: 'Prescription verification required', name: 'RxAuditError' },
  ];
  const validErrorResult = envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, validErrorNode);
  assert(
    validErrorResult instanceof Error && validErrorResult.message === 'Prescription verification required' && validErrorResult.name === 'RxAuditError',
    'Suite 16.13: Valid Error envelope within limits accepted and properly initialized'
  );

  // 16.14 Negative: ArrayBuffer Base64 exceeding independent maxBase64StringLength rejected in Pass 1
  // maxStringLength = 100, maxBase64StringLength = 120
  // Here Base64 string length = 124 (multiples of 4, canonical)
  const hugeBase64Payload = 'A'.repeat(124);
  const hugeBase64BufferNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: hugeBase64Payload, l: 93 },
  ];
  assertThrows(
    () => envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, hugeBase64BufferNode),
    'Suite 16.14: Reject ArrayBuffer Base64 payload exceeding independent maxBase64StringLength in Pass 1',
    'ArrayBuffer Base64 length (124) exceeds maximum limit (120)'
  );

  // 16.15 Positive: ArrayBuffer Base64 within maxBase64StringLength (even if larger than maxStringLength)
  // Base64 length = 104 > maxStringLength (100), but <= maxBase64StringLength (120)
  const validB64Payload = 'A'.repeat(104);
  const validBase64BufferNode: EnvelopeNode[] = [
    { '@': 1, t: 'ArrayBuffer', b: validB64Payload, l: 78 },
  ];
  const validB64Result = envelopeStringLimitsDeserializer.deserialize({ '#': 1 }, validBase64BufferNode);
  assert(
    validB64Result instanceof ArrayBuffer && validB64Result.byteLength === 78,
    'Suite 16.15: ArrayBuffer Base64 governed independently by maxBase64StringLength accepted'
  );
  console.log('\n================================================================');
  console.log(`TOTAL TESTS EXECUTED : ${totalTests}`);
  console.log(`PASSED               : ${passedTests}`);
  console.log(`FAILED               : ${failedTests}`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unhandled Test Suite Error:', err);
  process.exit(1);
});
