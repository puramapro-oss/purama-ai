// Upstream 0.4.9 CommonJS primitives have no declarations. Their protocol shape
// is constrained at OtsLibrary and checked against the real library in tests.
declare module 'opentimestamps/src/*.js' {
  const primitive: unknown;
  export default primitive;
}
