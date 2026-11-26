/**
 * Khalid Pharmacy Management System - Lossless Three-Pass Backup Serializer & Deserializer
 * Fully complies with P0.1.7 through P0.2.1-R2 Hardening Specifications.
 */

// ---------------------------------------------------------------------------
// 1. Types & Interfaces
// ---------------------------------------------------------------------------

export type AllowedTypeTag =
  | 'ArrayBuffer'
  | 'Int8Array'
  | 'Uint8Array'
  | 'Uint8ClampedArray'
  | 'Int16Array'
  | 'Uint16Array'
  | 'Int32Array'
  | 'Uint32Array'
  | 'Float32Array'
  | 'Float64Array'
  | 'BigInt64Array'
  | 'BigUint64Array'
  | 'DataView'
  | 'Date'
  | 'RegExp'
  | 'Map'
  | 'Set'
  | 'Array'
  | 'Object'
  | 'Error'
  | 'undefined'
  | 'BigInt'
  | 'num'
  | 'hole';

export interface EnvelopeRef {
  '#': number;
}

export interface EnvelopeNode {
  '@'?: number;
  t: AllowedTypeTag;
  v?: any;
  p?: Record<string, any>;
  [key: string]: any;
}

/**
 * Configurable Resource and Security Limits for Deserialization.
 * Enforced during Pass 1 before any memory allocation or Base64 decoding.
 */
export interface DeserializerLimits {
  /** Maximum byte length of any single ArrayBuffer (default: 50MB) */
  maxArrayBufferSize?: number;
  /** Maximum cumulative byte length of all decoded ArrayBuffers in one backup (default: 150MB) */
  maxTotalBinarySize?: number;
  /** Maximum total number of graph envelope nodes in backup payload (default: 500,000) */
  maxNodeCount?: number;
  /** Maximum length of arrays or collection entry lists (default: 100,000) */
  maxArrayLength?: number;
  /** Maximum number of properties on any single object or extra property map (default: 10,000) */
  maxObjectPropertyCount?: number;
  /** Maximum length of raw strings / metadata fields (default: 70MB) */
  maxStringLength?: number;
  /** Maximum length of Base64 encoded payload for ArrayBuffers (default: 70MB = ~50MB decoded binary) */
  maxBase64StringLength?: number;
  /** Maximum recursion depth for nested inline payloads to prevent call stack overflow DoS (default: 100) */
  maxRecursionDepth?: number;
}

/**
 * Standard Default Limits with Documented Rationale:
 * - maxArrayBufferSize (50 MiB): Upper bound for high-resolution document scans, OCR files, or attachments.
 * - maxTotalBinarySize (150 MiB): Upper bound for cumulative in-memory store binary payloads in IndexedDB export.
 * - maxNodeCount (500,000): Sufficient to represent large pharmacy inventory catalog + transaction graph without OOM.
 * - maxArrayLength (100,000): Prevents allocation of runaway sparse or gigantic arrays.
 * - maxObjectPropertyCount (10,000): Prevents property hash-flooding and memory exhaustion attacks.
 * - maxStringLength (70 MiB): Upper bound on general string and text payloads.
 * - maxBase64StringLength (70 MiB): Accommodates canonical Base64 encoding of a maximum single 50MB ArrayBuffer.
 * - maxRecursionDepth (100): Prevents call stack overflow DoS attacks from deeply nested inline structures.
 */
export const DEFAULT_DESERIALIZER_LIMITS: Required<DeserializerLimits> = {
  maxArrayBufferSize: 50 * 1024 * 1024,      // 50 MiB
  maxTotalBinarySize: 150 * 1024 * 1024,    // 150 MiB
  maxNodeCount: 500_000,
  maxArrayLength: 100_000,
  maxObjectPropertyCount: 10_000,
  maxStringLength: 70 * 1024 * 1024,        // 70 MiB
  maxBase64StringLength: 70 * 1024 * 1024,  // 70 MiB
  maxRecursionDepth: 100,
};

export const TYPED_ARRAY_CONSTRUCTORS: Record<string, any> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

export const TYPED_ARRAY_BYTES_PER_ELEMENT: Record<string, number> = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
  BigInt64Array: 8,
  BigUint64Array: 8,
};

export const ALLOWED_TYPE_TAGS = new Set<string>([
  'ArrayBuffer',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'Array',
  'Object',
  'Error',
  'undefined',
  'BigInt',
  'num',
  'hole',
]);

export const OBJECT_TYPE_TAGS = new Set<string>([
  'ArrayBuffer',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'Array',
  'Object',
  'Error',
]);

export const PRIMITIVE_TYPE_TAGS = new Set<string>([
  'undefined',
  'BigInt',
  'num',
  'hole',
]);

export const FORBIDDEN_PROPERTIES = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

export const TYPED_ARRAY_RESERVED_PROPS = new Set<string>([
  'buffer',
  'byteLength',
  'byteOffset',
  'length',
  'BYTES_PER_ELEMENT',
  'constructor',
  '__proto__',
  'prototype',
  'slice',
  'subarray',
  'set',
  'map',
  'forEach',
  'reduce',
  'reduceRight',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'indexOf',
  'lastIndexOf',
  'reverse',
  'sort',
  'values',
  'keys',
  'entries',
  'join',
  'includes',
  'copyWithin',
  'fill',
  'at',
]);

export const ARRAY_BUFFER_RESERVED_PROPS = new Set<string>([
  'byteLength',
  'maxByteLength',
  'resizable',
  'detached',
  'slice',
  'constructor',
  '__proto__',
  'prototype',
]);

export const DATAVIEW_RESERVED_PROPS = new Set<string>([
  'buffer',
  'byteLength',
  'byteOffset',
  'constructor',
  '__proto__',
  'prototype',
  'getInt8',
  'getUint8',
  'getInt16',
  'getUint16',
  'getInt32',
  'getUint32',
  'getFloat32',
  'getFloat64',
  'getBigInt64',
  'getBigUint64',
  'setInt8',
  'setUint8',
  'setInt16',
  'setUint16',
  'setInt32',
  'setUint32',
  'setFloat32',
  'setFloat64',
  'setBigInt64',
  'setBigUint64',
]);

export const REGEXP_RESERVED_PROPS = new Set<string>([
  'lastIndex',
  'source',
  'flags',
  'global',
  'ignoreCase',
  'multiline',
  'dotAll',
  'unicode',
  'unicodeSets',
  'sticky',
  'hasIndices',
  'constructor',
  '__proto__',
  'prototype',
]);

export const MAP_RESERVED_PROPS = new Set<string>([
  'size',
  'clear',
  'delete',
  'entries',
  'forEach',
  'get',
  'has',
  'keys',
  'set',
  'values',
  'constructor',
  '__proto__',
  'prototype',
]);

export const SET_RESERVED_PROPS = new Set<string>([
  'size',
  'add',
  'clear',
  'delete',
  'entries',
  'forEach',
  'has',
  'keys',
  'values',
  'constructor',
  '__proto__',
  'prototype',
]);

// ---------------------------------------------------------------------------
// 2. Base64 RFC 4648 Canonical Validation (Pass 1 - Pure String Validation)
// ---------------------------------------------------------------------------

/**
 * Strict RFC 4648 canonical Base64 validator regex.
 * Length must be multiple of 4.
 * Last 4 chars check:
 * - No padding: [A-Za-z0-9+/]{4}
 * - 2 '=' padding (1 data byte): [A-Za-z0-9+/]{1}[AQgw]== (unused 4 bits must be 0)
 * - 1 '=' padding (2 data bytes): [A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]= (unused 2 bits must be 0)
 */
const BASE64_CANONICAL_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{1}[AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

export function isValidBase64Canonical(b64: string): boolean {
  if (typeof b64 !== 'string') return false;
  if (b64.length === 0) return true;
  if (b64.length % 4 !== 0) return false;
  return BASE64_CANONICAL_REGEX.test(b64);
}

export function computeBase64DecodedByteLength(b64: string): number {
  if (b64.length === 0) return 0;
  let paddingCount = 0;
  if (b64.endsWith('==')) paddingCount = 2;
  else if (b64.endsWith('=')) paddingCount = 1;
  return Math.floor((b64.length * 3) / 4) - paddingCount;
}

export function base64ToUint8Array(b64: string): Uint8Array {
  if (b64.length === 0) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binaryString = atob(b64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 3. Lossless Serializer Engine
// ---------------------------------------------------------------------------

export class LosslessSerializer {
  private nextId = 1;
  private objToIdMap = new Map<any, number>();
  private nodes: EnvelopeNode[] = [];

  public serialize(root: any): { rootRef: any; nodes: EnvelopeNode[] } {
    this.nextId = 1;
    this.objToIdMap.clear();
    this.nodes = [];

    const rootRef = this.serializeValue(root);
    return {
      rootRef,
      nodes: this.nodes,
    };
  }

  /**
   * Safely collects extra user properties attached to built-in objects.
   * Throws an explicit error if dangerous property names (__proto__, constructor, prototype) are found.
   */
  private collectExtraProperties(val: any, reservedProps: Set<string>): Record<string, any> {
    const extraProps: Record<string, any> = {};
    for (const key of Object.getOwnPropertyNames(val)) {
      if (FORBIDDEN_PROPERTIES.has(key)) {
        throw new Error(
          `Serialization rejected: Unsafe property '${key}' detected on object. Prototype manipulation attempt blocked.`
        );
      }
      if (reservedProps.has(key)) {
        continue;
      }
      extraProps[key] = this.serializeValue((val as any)[key]);
    }
    return extraProps;
  }

  private serializeValue(val: any): any {
    if (val === undefined) {
      return { t: 'undefined' };
    }
    if (typeof val === 'bigint') {
      return { t: 'BigInt', v: val.toString() };
    }
    if (typeof val === 'number') {
      if (Number.isNaN(val)) return { t: 'num', v: 'NaN' };
      if (val === Infinity) return { t: 'num', v: 'Infinity' };
      if (val === -Infinity) return { t: 'num', v: '-Infinity' };
      if (Object.is(val, -0)) return { t: 'num', v: '-0' };
      return val;
    }
    if (val === null || typeof val === 'boolean' || typeof val === 'string') {
      return val;
    }
    if (typeof val === 'symbol' || typeof val === 'function') {
      throw new Error(`Unsupported type for serialization: ${typeof val}`);
    }

    // Reference types (Objects, Arrays, Buffers, Maps, Sets, etc.)
    if (this.objToIdMap.has(val)) {
      return { '#': this.objToIdMap.get(val)! };
    }

    const id = this.nextId++;
    this.objToIdMap.set(val, id);

    let node: EnvelopeNode;

    if (val instanceof ArrayBuffer) {
      const bytes = new Uint8Array(val);
      const extraProps = this.collectExtraProperties(val, ARRAY_BUFFER_RESERVED_PROPS);
      node = {
        '@': id,
        t: 'ArrayBuffer',
        b: uint8ArrayToBase64(bytes),
        l: val.byteLength,
      };
      if (Object.keys(extraProps).length > 0) {
        node.p = extraProps;
      }
    } else if (ArrayBuffer.isView(val)) {
      const bufferRef = this.serializeValue(val.buffer);
      if (val instanceof DataView) {
        const extraProps = this.collectExtraProperties(val, DATAVIEW_RESERVED_PROPS);
        node = {
          '@': id,
          t: 'DataView',
          b: bufferRef,
          o: val.byteOffset,
          l: val.byteLength,
        };
        if (Object.keys(extraProps).length > 0) {
          node.p = extraProps;
        }
      } else {
        const cstrName = val.constructor.name as AllowedTypeTag;
        if (!TYPED_ARRAY_CONSTRUCTORS[cstrName]) {
          throw new Error(`Unsupported TypedArray type: ${cstrName}`);
        }
        // Collect extra properties excluding reserved props and numeric indices
        const extraProps: Record<string, any> = {};
        for (const key of Object.getOwnPropertyNames(val)) {
          if (FORBIDDEN_PROPERTIES.has(key)) {
            throw new Error(
              `Serialization rejected: Unsafe property '${key}' detected on TypedArray. Prototype manipulation attempt blocked.`
            );
          }
          if (TYPED_ARRAY_RESERVED_PROPS.has(key)) {
            continue;
          }
          const numKey = Number(key);
          if (Number.isInteger(numKey) && numKey >= 0 && numKey < (val as any).length && String(numKey) === key) {
            continue; // Array index element
          }
          extraProps[key] = this.serializeValue((val as any)[key]);
        }

        node = {
          '@': id,
          t: cstrName,
          b: bufferRef,
          o: val.byteOffset,
          l: (val as any).length,
        };
        if (Object.keys(extraProps).length > 0) {
          node.p = extraProps;
        }
      }
    } else if (val instanceof Date) {
      const isInvalid = Number.isNaN(val.getTime());
      const extraProps = this.collectExtraProperties(val, new Set());
      node = {
        '@': id,
        t: 'Date',
        v: isInvalid ? 'Invalid Date' : val.toISOString(),
      };
      if (Object.keys(extraProps).length > 0) {
        node.p = extraProps;
      }
    } else if (val instanceof RegExp) {
      const extraProps = this.collectExtraProperties(val, REGEXP_RESERVED_PROPS);
      node = {
        '@': id,
        t: 'RegExp',
        s: val.source,
        f: val.flags,
        i: val.lastIndex,
      };
      if (Object.keys(extraProps).length > 0) {
        node.p = extraProps;
      }
    } else if (val instanceof Map) {
      const entries: Array<[any, any]> = [];
      for (const [k, v] of val.entries()) {
        entries.push([this.serializeValue(k), this.serializeValue(v)]);
      }
      const extraProps = this.collectExtraProperties(val, MAP_RESERVED_PROPS);
      node = {
        '@': id,
        t: 'Map',
        e: entries,
      };
      if (Object.keys(extraProps).length > 0) {
        node.p = extraProps;
      }
    } else if (val instanceof Set) {
      const items: any[] = [];
      for (const item of val.values()) {
        items.push(this.serializeValue(item));
      }
      const extraProps = this.collectExtraProperties(val, SET_RESERVED_PROPS);
      node = {
        '@': id,
        t: 'Set',
        e: items,
      };
      if (Object.keys(extraProps).length > 0) {
        node.p = extraProps;
      }
    } else if (Array.isArray(val)) {
      const elements: any[] = [];
      const len = val.length;
      for (let i = 0; i < len; i++) {
        if (!(i in val)) {
          elements.push({ t: 'hole' });
        } else {
          elements.push(this.serializeValue(val[i]));
        }
      }
      const extraProps: Record<string, any> = {};
      for (const key of Object.getOwnPropertyNames(val)) {
        if (FORBIDDEN_PROPERTIES.has(key)) {
          throw new Error(
            `Serialization rejected: Unsafe property '${key}' detected on Array. Prototype manipulation attempt blocked.`
          );
        }
        if (key === 'length') continue;
        const numKey = Number(key);
        if (Number.isInteger(numKey) && numKey >= 0 && numKey < len && String(numKey) === key) {
          continue;
        }
        extraProps[key] = this.serializeValue((val as any)[key]);
      }
      node = {
        '@': id,
        t: 'Array',
        l: len,
        e: elements,
      };
      if (Object.keys(extraProps).length > 0) {
        node.p = extraProps;
      }
    } else if (typeof val === 'object') {
      const proto = Object.getPrototypeOf(val);
      const isNullProto = proto === null;
      const properties: Record<string, any> = {};
      for (const key of Object.getOwnPropertyNames(val)) {
        if (FORBIDDEN_PROPERTIES.has(key)) {
          throw new Error(
            `Serialization rejected: Unsafe property '${key}' detected on Object. Prototype manipulation attempt blocked.`
          );
        }
        properties[key] = this.serializeValue(val[key]);
      }
      node = {
        '@': id,
        t: 'Object',
        np: isNullProto ? true : undefined,
        p: properties,
      };
    } else {
      throw new Error(`Unhandled serialization object type`);
    }

    this.nodes.push(node);
    return { '#': id };
  }
}

// ---------------------------------------------------------------------------
// 4. Three-Pass Deserializer Engine
// ---------------------------------------------------------------------------

export class ThreePassDeserializer {
  private limits: Required<DeserializerLimits>;
  private idToEnvelopeMap = Object.create(null) as Record<number, EnvelopeNode>;
  private idToInstanceMap = Object.create(null) as Record<number, any>;
  private currentCumulativeBinaryBytes = 0;
  private pendingBufferBoundsChecks: Array<{
    viewId: number;
    bufferId: number;
    byteOffset: number;
    byteLength: number;
    typeTag: string;
  }> = [];

  constructor(customLimits?: DeserializerLimits) {
    this.limits = {
      ...DEFAULT_DESERIALIZER_LIMITS,
      ...customLimits,
    };
  }

  public deserialize(rootRef: any, nodes: EnvelopeNode[]): any {
    this.idToEnvelopeMap = Object.create(null);
    this.idToInstanceMap = Object.create(null);
    this.pendingBufferBoundsChecks = [];
    this.currentCumulativeBinaryBytes = 0;

    // PASS 1: Comprehensive Scanning, Envelope Validation & Inline Value/Depth Resource Audits
    this.pass1Scan(rootRef, nodes);

    // PASS 2: Structural Instantiation & Identity Registration
    this.pass2Instantiate(nodes);

    // PASS 3: Reference Linking, Property Population & Post-Instantiation Integrity Bounds Verification
    this.pass3LinkAndPopulate(nodes);

    // Final Post-Linking Buffer Bounds Audit
    this.verifyBufferBounds();

    return this.resolveRef(rootRef);
  }

  // -------------------------------------------------------------------------
  // PASS 1: Comprehensive Validation
  // -------------------------------------------------------------------------

  private pass1Scan(rootRef: any, nodes: EnvelopeNode[]): void {
    if (!Array.isArray(nodes)) {
      throw new Error('Deserializer Pass 1: Node list must be an array');
    }

    if (nodes.length > this.limits.maxNodeCount) {
      throw new Error(
        `Deserializer Pass 1 Security Violation: Node count (${nodes.length}) exceeds maximum limit (${this.limits.maxNodeCount})`
      );
    }

    const seenIds = new Set<number>();
    this.currentCumulativeBinaryBytes = 0;

    // Validate rootRef inline values and recursion depth
    this.validateInlineValueAndDepth(rootRef, 1);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || typeof node !== 'object') {
        throw new Error(`Deserializer Pass 1: Node at index ${i} is not a valid object`);
      }

      // Check Tag Allowlist
      if (!node.t || typeof node.t !== 'string' || !ALLOWED_TYPE_TAGS.has(node.t)) {
        throw new Error(`Deserializer Pass 1: Disallowed or missing type tag '${node?.t}'`);
      }

      const isObjectTag = OBJECT_TYPE_TAGS.has(node.t);
      const isPrimitiveTag = PRIMITIVE_TYPE_TAGS.has(node.t);

      if (isPrimitiveTag) {
        if (Object.hasOwn(node, '@')) {
          throw new Error(`Deserializer Pass 1: Primitive tag '${node.t}' must not contain '@' ID`);
        }
        this.validatePrimitiveEnvelope(node);
        continue;
      }

      if (isObjectTag) {
        if (!Object.hasOwn(node, '@')) {
          throw new Error(`Deserializer Pass 1: Object tag '${node.t}' is missing required '@' ID`);
        }

        const id = node['@'];
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
          throw new Error(`Deserializer Pass 1: Invalid '@' ID value '${id}' for node tag '${node.t}'`);
        }

        if (seenIds.has(id)) {
          throw new Error(`Deserializer Pass 1: Duplicate '@' ID detected '${id}'`);
        }

        seenIds.add(id);
        this.idToEnvelopeMap[id] = node;

        // Structural and Field Type Validation for Object Tag (with Resource Limit Audits)
        this.validateObjectEnvelopeStructure(node);
      }
    }
  }

  /**
   * Recursively validates inline nested values in Pass 1 for:
   * - Max String Length (maxStringLength) on all inline strings (elements, properties, keys, values).
   * - Max Recursion Depth (maxRecursionDepth) to prevent Call Stack Overflow DoS.
   * - Dangerous property names (__proto__, constructor, prototype) and prototype pollution.
   */
  private validateInlineValueAndDepth(val: any, currentDepth: number, visited?: Set<any>): void {
    if (currentDepth > this.limits.maxRecursionDepth) {
      throw new Error(
        `Security Violation: Exceeded maximum allowed recursion depth (${this.limits.maxRecursionDepth}) during Pass 1 value validation.`
      );
    }

    if (val === null || val === undefined) {
      return;
    }

    if (typeof val === 'string') {
      if (val.length > this.limits.maxStringLength) {
        throw new Error(
          `Security Violation: String length (${val.length}) exceeds maximum limit (${this.limits.maxStringLength}) during Pass 1 value validation.`
        );
      }
      return;
    }

    if (typeof val === 'number' || typeof val === 'boolean') {
      return;
    }

    if (typeof val === 'object') {
      // 1. Envelope Reference {"#": 123}
      if (Object.hasOwn(val, '#')) {
        const refId = val['#'];
        if (typeof refId !== 'number' || !Number.isSafeInteger(refId) || refId <= 0) {
          throw new Error(`Deserializer Pass 1: Invalid '#' reference ID '${refId}'`);
        }
        // Strict check: Envelope references must not contain extraneous properties
        const refKeys = Object.getOwnPropertyNames(val);
        if (refKeys.length > 1) {
          throw new Error(`Deserializer Pass 1: Envelope reference contains extraneous properties`);
        }
        return; // Valid envelope reference to a node, no inline recursion needed
      }

      // 2. Primitive Envelope { t: 'undefined' | 'BigInt' | 'num' | 'hole' }
      if (val.t && PRIMITIVE_TYPE_TAGS.has(val.t)) {
        if (Object.hasOwn(val, '@')) {
          throw new Error(`Deserializer Pass 1: Primitive tag '${val.t}' must not contain '@' ID`);
        }
        this.validatePrimitiveEnvelope(val);
        return;
      }

      // Cycle protection for inline nested objects/arrays
      const activeVisited = visited || new Set<any>();
      if (activeVisited.has(val)) {
        return;
      }
      activeVisited.add(val);

      // 3. Inline Array
      if (Array.isArray(val)) {
        if (val.length > this.limits.maxArrayLength) {
          throw new Error(
            `Array length (${val.length}) exceeds maximum allowed limit (${this.limits.maxArrayLength}) during Pass 1 value validation.`
          );
        }
        for (let i = 0; i < val.length; i++) {
          this.validateInlineValueAndDepth(val[i], currentDepth + 1, activeVisited);
        }
      } else {
        // 4. Inline Object
        const proto = Object.getPrototypeOf(val);
        if (proto !== null && proto !== Object.prototype) {
          throw new Error(
            `Security Violation: Dangerous property '__proto__' or invalid prototype detected in envelope properties. Prototype manipulation blocked.`
          );
        }

        const keys = Object.getOwnPropertyNames(val);
        if (keys.length > this.limits.maxObjectPropertyCount) {
          throw new Error(
            `Properties count (${keys.length}) exceeds maximum allowed limit (${this.limits.maxObjectPropertyCount})`
          );
        }

        for (const key of keys) {
          if (FORBIDDEN_PROPERTIES.has(key)) {
            throw new Error(
              `Security Violation: Dangerous property '${key}' detected in envelope properties. Prototype manipulation blocked.`
            );
          }
          if (key.length > this.limits.maxStringLength) {
            throw new Error(
              `Security Violation: Property key length (${key.length}) exceeds maximum string limit (${this.limits.maxStringLength}).`
            );
          }
          this.validateInlineValueAndDepth(val[key], currentDepth + 1, activeVisited);
        }
      }

      activeVisited.delete(val);
    }
  }

  private validatePrimitiveEnvelope(node: EnvelopeNode): void {
    switch (node.t) {
      case 'undefined':
      case 'hole':
        break;
      case 'BigInt':
        if (typeof node.v !== 'string') {
          throw new Error(`Deserializer Pass 1: BigInt envelope missing string value 'v'`);
        }
        if (node.v.length > this.limits.maxStringLength) {
          throw new Error(
            `Deserializer Pass 1: BigInt string length (${node.v.length}) exceeds maximum limit (${this.limits.maxStringLength})`
          );
        }
        if (!/^-?\d+$/.test(node.v)) {
          throw new Error(`Deserializer Pass 1: Invalid BigInt string representation '${node.v}'`);
        }
        break;
      case 'num':
        if (typeof node.v !== 'string') {
          throw new Error(`Deserializer Pass 1: Special numeric envelope missing string 'v'`);
        }
        if (node.v.length > this.limits.maxStringLength) {
          throw new Error(
            `Deserializer Pass 1: Special numeric string length exceeds maximum limit (${this.limits.maxStringLength})`
          );
        }
        if (!['NaN', 'Infinity', '-Infinity', '-0'].includes(node.v)) {
          throw new Error(`Deserializer Pass 1: Invalid special numeric string value '${node.v}'`);
        }
        break;
    }
  }

  /**
   * Validates structure and enforces resource limit audits in Pass 1.
   */
  private validateObjectEnvelopeStructure(node: EnvelopeNode): void {
    switch (node.t) {
      case 'ArrayBuffer': {
        if (typeof node.l !== 'number' || !Number.isSafeInteger(node.l) || node.l < 0) {
          throw new Error(`ArrayBuffer envelope length 'l' must be a non-negative safe integer`);
        }
        if (node.l > this.limits.maxArrayBufferSize) {
          throw new Error(
            `ArrayBuffer size (${node.l} bytes) exceeds maximum buffer limit (${this.limits.maxArrayBufferSize} bytes)`
          );
        }
        if (this.currentCumulativeBinaryBytes + node.l > this.limits.maxTotalBinarySize) {
          throw new Error(
            `Deserializer Pass 1 Security Violation: Total cumulative binary size (${this.currentCumulativeBinaryBytes + node.l} bytes) exceeds maximum limit (${this.limits.maxTotalBinarySize} bytes)`
          );
        }
        if (typeof node.b !== 'string') {
          throw new Error(`ArrayBuffer envelope missing base64 string 'b'`);
        }
        const maxB64Len = this.limits.maxBase64StringLength ?? this.limits.maxStringLength;
        if (node.b.length > maxB64Len) {
          throw new Error(
            `ArrayBuffer Base64 length (${node.b.length}) exceeds maximum limit (${maxB64Len})`
          );
        }
        if (!isValidBase64Canonical(node.b)) {
          throw new Error(`ArrayBuffer envelope base64 string failed RFC 4648 canonical validation`);
        }
        const decodedLength = computeBase64DecodedByteLength(node.b);
        if (decodedLength !== node.l) {
          throw new Error(
            `ArrayBuffer byte length mismatch: Expected ${node.l}, decoded Base64 length is ${decodedLength}`
          );
        }
        this.currentCumulativeBinaryBytes += node.l;
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, ARRAY_BUFFER_RESERVED_PROPS);
        }
        break;
      }
      case 'Int8Array':
      case 'Uint8Array':
      case 'Uint8ClampedArray':
      case 'Int16Array':
      case 'Uint16Array':
      case 'Int32Array':
      case 'Uint32Array':
      case 'Float32Array':
      case 'Float64Array':
      case 'BigInt64Array':
      case 'BigUint64Array': {
        this.validateBufferViewFields(node);
        const elementBytes = TYPED_ARRAY_BYTES_PER_ELEMENT[node.t];
        if (node.o % elementBytes !== 0) {
          throw new Error(
            `${node.t} byteOffset ${node.o} is not aligned to element size ${elementBytes}`
          );
        }
        if (node.p !== undefined) {
          this.validateTypedArrayExtraProperties(node.p, node.l);
        }
        break;
      }
      case 'DataView': {
        this.validateBufferViewFields(node);
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, DATAVIEW_RESERVED_PROPS);
        }
        break;
      }
      case 'Date': {
        if (typeof node.v !== 'string') {
          throw new Error(`Date envelope missing date string 'v'`);
        }
        if (node.v.length > this.limits.maxStringLength) {
          throw new Error(
            `Date string length (${node.v.length}) exceeds maximum string limit (${this.limits.maxStringLength})`
          );
        }
        if (node.v !== 'Invalid Date' && Number.isNaN(Date.parse(node.v))) {
          throw new Error(`Date envelope contains invalid date format '${node.v}'`);
        }
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, new Set());
        }
        break;
      }
      case 'RegExp': {
        if (typeof node.s !== 'string') {
          throw new Error(`RegExp envelope missing source string 's'`);
        }
        if (typeof node.f !== 'string') {
          throw new Error(`RegExp envelope missing flags string 'f'`);
        }
        if (node.s.length > this.limits.maxStringLength) {
          throw new Error(
            `RegExp envelope pattern length (${node.s.length}) exceeds maximum limit (${this.limits.maxStringLength})`
          );
        }
        if (node.f.length > this.limits.maxStringLength || node.f.length > 50) {
          throw new Error(`RegExp envelope flags length exceeds allowed limits`);
        }
        if (!/^[gimsuyvd]*$/.test(node.f)) {
          throw new Error(`RegExp envelope contains invalid flag characters '${node.f}'`);
        }
        if (node.f.includes('u') && node.f.includes('v')) {
          throw new Error(`RegExp envelope cannot combine both 'u' and 'v' flags`);
        }
        // Test RegExp compilation syntax without instantiating global node
        try {
          new RegExp(node.s, node.f);
        } catch (err: any) {
          throw new Error(`RegExp envelope syntax validation failed: ${err.message}`);
        }
        if (node.i !== undefined && (typeof node.i !== 'number' || !Number.isSafeInteger(node.i) || node.i < 0)) {
          throw new Error(`RegExp envelope lastIndex 'i' must be a non-negative safe integer`);
        }
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, REGEXP_RESERVED_PROPS);
        }
        break;
      }
      case 'BigInt': {
        if (typeof node.v !== 'string') {
          throw new Error(`Deserializer Pass 1: BigInt envelope missing string value 'v'`);
        }
        if (node.v.length > this.limits.maxStringLength) {
          throw new Error(
            `Deserializer Pass 1: BigInt string length (${node.v.length}) exceeds maximum limit (${this.limits.maxStringLength})`
          );
        }
        if (!/^-?\d+$/.test(node.v)) {
          throw new Error(`Deserializer Pass 1: Invalid BigInt string representation '${node.v}'`);
        }
        break;
      }
      case 'num': {
        if (typeof node.v !== 'string') {
          throw new Error(`Deserializer Pass 1: Special numeric envelope missing string 'v'`);
        }
        if (node.v.length > this.limits.maxStringLength) {
          throw new Error(
            `Deserializer Pass 1: Special numeric string length exceeds maximum limit (${this.limits.maxStringLength})`
          );
        }
        if (!['NaN', 'Infinity', '-Infinity', '-0'].includes(node.v)) {
          throw new Error(`Deserializer Pass 1: Invalid special numeric string value '${node.v}'`);
        }
        break;
      }
      case 'Error': {
        if (typeof node.message !== 'string') {
          throw new Error(`Error envelope missing message string`);
        }
        if (node.message.length > this.limits.maxStringLength) {
          throw new Error(
            `Error envelope message length (${node.message.length}) exceeds maximum limit (${this.limits.maxStringLength})`
          );
        }
        if (node.name !== undefined) {
          if (typeof node.name !== 'string') {
            throw new Error(`Error envelope name must be a string`);
          }
          if (node.name.length > this.limits.maxStringLength) {
            throw new Error(
              `Error envelope name length (${node.name.length}) exceeds maximum limit (${this.limits.maxStringLength})`
            );
          }
        }
        if (node.stack !== undefined) {
          if (typeof node.stack !== 'string') {
            throw new Error(`Error envelope stack must be a string`);
          }
          if (node.stack.length > this.limits.maxStringLength) {
            throw new Error(
              `Error envelope stack length (${node.stack.length}) exceeds maximum limit (${this.limits.maxStringLength})`
            );
          }
        }
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, new Set(['message', 'name', 'stack']));
        }
        break;
      }
      case 'Map': {
        if (!Array.isArray(node.e)) {
          throw new Error(`Map envelope missing entries array 'e'`);
        }
        if (node.e.length > this.limits.maxArrayLength) {
          throw new Error(`Map entries count (${node.e.length}) exceeds maximum allowed limit (${this.limits.maxArrayLength})`);
        }
        for (const entry of node.e) {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error(`Map envelope entry must be a 2-tuple key-value pair`);
          }
          this.validateInlineValueAndDepth(entry[0], 1);
          this.validateInlineValueAndDepth(entry[1], 1);
        }
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, MAP_RESERVED_PROPS);
        }
        break;
      }
      case 'Set': {
        if (!Array.isArray(node.e)) {
          throw new Error(`Set envelope missing items array 'e'`);
        }
        if (node.e.length > this.limits.maxArrayLength) {
          throw new Error(`Set items count (${node.e.length}) exceeds maximum allowed limit (${this.limits.maxArrayLength})`);
        }
        for (const item of node.e) {
          this.validateInlineValueAndDepth(item, 1);
        }
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, SET_RESERVED_PROPS);
        }
        break;
      }
      case 'Array': {
        if (typeof node.l !== 'number' || !Number.isSafeInteger(node.l) || node.l < 0) {
          throw new Error(`Array envelope length 'l' must be a non-negative safe integer`);
        }
        if (node.l > this.limits.maxArrayLength) {
          throw new Error(`Array envelope length (${node.l}) exceeds maximum allowed limit (${this.limits.maxArrayLength})`);
        }
        if (!Array.isArray(node.e)) {
          throw new Error(`Array envelope missing elements array 'e'`);
        }
        // Strict Array Envelope integrity check: elements array length must exactly match declared length
        if (node.e.length !== node.l) {
          throw new Error(
            `Array envelope elements count (${node.e.length}) does not match declared length (${node.l})`
          );
        }
        for (let i = 0; i < node.e.length; i++) {
          this.validateInlineValueAndDepth(node.e[i], 1);
        }
        if (node.p !== undefined) {
          this.validateArrayExtraProperties(node.p, node.l);
        }
        break;
      }
      case 'Object': {
        if (node.np !== undefined && typeof node.np !== 'boolean') {
          throw new Error(`Object envelope np flag must be a boolean`);
        }
        if (node.p !== undefined) {
          this.validateExtraProperties(node.p, new Set());
        }
        break;
      }
    }
  }

  private validateBufferViewFields(node: EnvelopeNode): void {
    if (!node.b || typeof node.b !== 'object' || typeof node.b['#'] !== 'number') {
      throw new Error(`${node.t} envelope missing valid buffer reference 'b'`);
    }
    if (typeof node.o !== 'number' || !Number.isSafeInteger(node.o) || node.o < 0) {
      throw new Error(`${node.t} envelope byteOffset 'o' must be a non-negative safe integer`);
    }
    if (typeof node.l !== 'number' || !Number.isSafeInteger(node.l) || node.l < 0) {
      throw new Error(`${node.t} envelope length 'l' must be a non-negative safe integer`);
    }
    if (node.l > this.limits.maxArrayLength) {
      throw new Error(`${node.t} view length (${node.l}) exceeds maximum allowed array length`);
    }
  }

  private validateExtraProperties(props: any, reservedKeys: Set<string> = new Set()): void {
    if (props === null || typeof props !== 'object' || Array.isArray(props)) {
      throw new Error(`Properties payload 'p' must be an object map`);
    }

    // Recursively validate properties payload values and depth
    this.validateInlineValueAndDepth(props, 1);

    for (const key of Object.getOwnPropertyNames(props)) {
      if (reservedKeys.has(key)) {
        throw new Error(`Property key '${key}' collides with reserved built-in property`);
      }
    }
  }

  private validateTypedArrayExtraProperties(props: any, arrayLength: number): void {
    this.validateExtraProperties(props, TYPED_ARRAY_RESERVED_PROPS);
    for (const key of Object.getOwnPropertyNames(props)) {
      const numKey = Number(key);
      if (Number.isInteger(numKey) && numKey >= 0 && numKey < arrayLength && String(numKey) === key) {
        throw new Error(`TypedArray extra property key '${key}' collides with element index`);
      }
    }
  }

  private validateArrayExtraProperties(props: any, arrayLength: number): void {
    this.validateExtraProperties(props, new Set(['length']));
    for (const key of Object.getOwnPropertyNames(props)) {
      const numKey = Number(key);
      if (Number.isInteger(numKey) && numKey >= 0 && numKey < arrayLength && String(numKey) === key) {
        throw new Error(`Array extra property key '${key}' collides with existing array index`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2: Structural Instantiation & Identity Registration
  // -------------------------------------------------------------------------

  private pass2Instantiate(nodes: EnvelopeNode[]): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!OBJECT_TYPE_TAGS.has(node.t)) continue;

      const id = node['@']!;
      let instance: any;

      switch (node.t) {
        case 'ArrayBuffer': {
          const uint8 = base64ToUint8Array(node.b);
          instance = uint8.buffer;
          break;
        }
        case 'Int8Array':
        case 'Uint8Array':
        case 'Uint8ClampedArray':
        case 'Int16Array':
        case 'Uint16Array':
        case 'Int32Array':
        case 'Uint32Array':
        case 'Float32Array':
        case 'Float64Array':
        case 'BigInt64Array':
        case 'BigUint64Array':
        case 'DataView': {
          // Deferred instantiation in Pass 3 once target ArrayBuffer instance is available
          instance = null; 
          break;
        }
        case 'Date': {
          instance = node.v === 'Invalid Date' ? new Date(NaN) : new Date(node.v);
          break;
        }
        case 'RegExp': {
          instance = new RegExp(node.s, node.f);
          if (node.i !== undefined) {
            instance.lastIndex = node.i;
          }
          break;
        }
        case 'Error': {
          const err = new Error(node.message);
          if (node.name) err.name = node.name;
          if (node.stack) err.stack = node.stack;
          instance = err;
          break;
        }
        case 'Map': {
          instance = new Map();
          break;
        }
        case 'Set': {
          instance = new Set();
          break;
        }
        case 'Array': {
          instance = new Array(node.l);
          break;
        }
        case 'Object': {
          instance = node.np ? Object.create(null) : {};
          break;
        }
      }

      this.idToInstanceMap[id] = instance;
    }
  }

  // -------------------------------------------------------------------------
  // PASS 3: Linking & Mutating References & Properties
  // -------------------------------------------------------------------------

  private pass3LinkAndPopulate(nodes: EnvelopeNode[]): void {
    // Step 3A: Instantiate Buffer Views (TypedArrays / DataView) after ArrayBuffer targets exist
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (
        node.t === 'DataView' ||
        TYPED_ARRAY_CONSTRUCTORS[node.t]
      ) {
        const id = node['@']!;
        const bufferId = node.b['#'];
        const bufferInstance = this.idToInstanceMap[bufferId];

        if (!bufferInstance || !(bufferInstance instanceof ArrayBuffer)) {
          throw new Error(`Pass 3: Referenced buffer #${bufferId} is not a valid ArrayBuffer instance`);
        }

        const byteOffset = node.o;
        const lengthOrBytes = node.l;
        let viewInstance: any;

        if (node.t === 'DataView') {
          const requiredBytes = byteOffset + lengthOrBytes;
          if (requiredBytes > bufferInstance.byteLength) {
            throw new Error(
              `Buffer bounds overflow: View #${id} (DataView) requires byte range [${byteOffset}, ${requiredBytes}], but ArrayBuffer #${bufferId} length is ${bufferInstance.byteLength}`
            );
          }
          viewInstance = new DataView(bufferInstance, byteOffset, lengthOrBytes);
          this.pendingBufferBoundsChecks.push({
            viewId: id,
            bufferId,
            byteOffset,
            byteLength: lengthOrBytes,
            typeTag: 'DataView',
          });
        } else {
          const Cstr = TYPED_ARRAY_CONSTRUCTORS[node.t];
          const elementBytes = TYPED_ARRAY_BYTES_PER_ELEMENT[node.t];
          const calculatedByteLength = lengthOrBytes * elementBytes;
          const requiredBytes = byteOffset + calculatedByteLength;
          if (requiredBytes > bufferInstance.byteLength) {
            throw new Error(
              `Buffer bounds overflow: View #${id} (${node.t}) requires byte range [${byteOffset}, ${requiredBytes}], but ArrayBuffer #${bufferId} length is ${bufferInstance.byteLength}`
            );
          }

          viewInstance = new Cstr(bufferInstance, byteOffset, lengthOrBytes);
          this.pendingBufferBoundsChecks.push({
            viewId: id,
            bufferId,
            byteOffset,
            byteLength: calculatedByteLength,
            typeTag: node.t,
          });
        }

        this.idToInstanceMap[id] = viewInstance;
      }
    }

    // Step 3B: Populate properties, elements, Map entries, Set values, and extra properties
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!OBJECT_TYPE_TAGS.has(node.t)) continue;

      const id = node['@']!;
      const instance = this.idToInstanceMap[id];

      switch (node.t) {
        case 'Map': {
          const mapInstance = instance as Map<any, any>;
          for (const [kRef, vRef] of node.e) {
            const key = this.resolveValue(kRef);
            const val = this.resolveValue(vRef);
            mapInstance.set(key, val);
          }
          if (node.p) {
            this.populateObjectProperties(instance, node.p);
          }
          break;
        }
        case 'Set': {
          const setInstance = instance as Set<any>;
          for (const itemRef of node.e) {
            const item = this.resolveValue(itemRef);
            setInstance.add(item);
          }
          if (node.p) {
            this.populateObjectProperties(instance, node.p);
          }
          break;
        }
        case 'Array': {
          const arrInstance = instance as any[];
          for (let idx = 0; idx < node.e.length; idx++) {
            const elemRef = node.e[idx];
            if (elemRef && typeof elemRef === 'object' && elemRef.t === 'hole') {
              continue; // Leave sparse hole empty
            }
            arrInstance[idx] = this.resolveValue(elemRef);
          }
          if (node.p) {
            this.populateObjectProperties(arrInstance, node.p);
          }
          break;
        }
        case 'ArrayBuffer':
        case 'DataView':
        case 'Date':
        case 'RegExp':
        case 'Error':
        case 'Object':
        case 'Int8Array':
        case 'Uint8Array':
        case 'Uint8ClampedArray':
        case 'Int16Array':
        case 'Uint16Array':
        case 'Int32Array':
        case 'Uint32Array':
        case 'Float32Array':
        case 'Float64Array':
        case 'BigInt64Array':
        case 'BigUint64Array': {
          if (node.p) {
            this.populateObjectProperties(instance, node.p);
          }
          break;
        }
      }
    }
  }

  private populateObjectProperties(target: any, propsEnvelope: Record<string, any>): void {
    for (const propKey of Object.getOwnPropertyNames(propsEnvelope)) {
      if (FORBIDDEN_PROPERTIES.has(propKey)) {
        throw new Error(
          `Deserializer Pass 3 Security Violation: Unsafe property '${propKey}' detected in property population.`
        );
      }
      const propVal = this.resolveValue(propsEnvelope[propKey]);
      Object.defineProperty(target, propKey, {
        value: propVal,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  private resolveValue(valRef: any): any {
    if (valRef === null || typeof valRef !== 'object') {
      return valRef;
    }

    if (Object.hasOwn(valRef, '#')) {
      return this.resolveRef(valRef);
    }

    if (valRef.t) {
      switch (valRef.t) {
        case 'undefined':
          return undefined;
        case 'BigInt':
          return BigInt(valRef.v);
        case 'num': {
          if (valRef.v === 'NaN') return NaN;
          if (valRef.v === 'Infinity') return Infinity;
          if (valRef.v === '-Infinity') return -Infinity;
          if (valRef.v === '-0') return -0;
          break;
        }
        case 'hole':
          return undefined;
      }
    }

    // Direct plain object or array nesting in envelope values
    if (Array.isArray(valRef)) {
      return valRef.map(item => this.resolveValue(item));
    }

    const res: Record<string, any> = {};
    for (const k of Object.keys(valRef)) {
      if (FORBIDDEN_PROPERTIES.has(k)) {
        throw new Error(
          `Security Violation: Dangerous property '${k}' detected in nested envelope value.`
        );
      }
      res[k] = this.resolveValue(valRef[k]);
    }
    return res;
  }

  private resolveRef(ref: any): any {
    if (ref === null || typeof ref !== 'object') return ref;
    if (Object.hasOwn(ref, '#')) {
      const id = ref['#'];
      if (!Object.hasOwn(this.idToInstanceMap, id)) {
        throw new Error(`Deserializer Pass 3: Dangling reference detected for '#' ID ${id}`);
      }
      return this.idToInstanceMap[id];
    }
    return this.resolveValue(ref);
  }

  private verifyBufferBounds(): void {
    for (const item of this.pendingBufferBoundsChecks) {
      const bufferInstance = this.idToInstanceMap[item.bufferId] as ArrayBuffer;
      if (!bufferInstance) {
        throw new Error(`Buffer bounds verification failed: Buffer #${item.bufferId} missing`);
      }
      const totalRequiredByteEnd = item.byteOffset + item.byteLength;
      if (totalRequiredByteEnd > bufferInstance.byteLength) {
        throw new Error(
          `Buffer bounds overflow: View #${item.viewId} (${item.typeTag}) requires byte range [${item.byteOffset}, ${totalRequiredByteEnd}], but ArrayBuffer #${item.bufferId} length is ${bufferInstance.byteLength}`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Convenience API Wrappers
// ---------------------------------------------------------------------------

export function serializeLossless(root: any): { rootRef: any; nodes: EnvelopeNode[] } {
  const serializer = new LosslessSerializer();
  return serializer.serialize(root);
}

export function deserializeLossless(
  rootRef: any,
  nodes: EnvelopeNode[],
  customLimits?: DeserializerLimits
): any {
  const deserializer = new ThreePassDeserializer(customLimits);
  return deserializer.deserialize(rootRef, nodes);
}
