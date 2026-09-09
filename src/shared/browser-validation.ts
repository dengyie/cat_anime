import * as v from 'valibot'
export * from 'valibot'

// JSON object contracts exclude arrays. Valibot's object and record parsers
// also accept arrays, so check the raw value before their structural parser.
const jsonObject = () => v.custom<Record<string, unknown>>((value) => value !== null && typeof value === 'object' && !Array.isArray(value))
export const object = <T extends v.ObjectEntries>(entries: T) => v.pipe(jsonObject(), v.object(entries))
export const strictObject = <T extends v.ObjectEntries>(entries: T) => v.pipe(jsonObject(), v.strictObject(entries))
export const looseObject = <T extends v.ObjectEntries>(entries: T) => v.pipe(jsonObject(), v.looseObject(entries))
export const record = <K extends v.GenericSchema<string>, V extends v.GenericSchema>(key: K, value: V) => v.pipe(jsonObject(), v.record(key, value))
