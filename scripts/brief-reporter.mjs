// node:test reporter used for mutation runs. Prints one line per failing test,
// "<test name> :: <ErrorName>: <first line of message>", and nothing else, so
// Stryker's reports stay small, contain no local paths, and still record
// whether a mutant was killed by an assertion or by a crash.
export default async function* briefReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue
    const error = event.data.details?.error
    const cause = error?.cause ?? error
    const name = cause?.name ?? 'Error'
    const message = String(cause?.message ?? '').split('\n')[0].slice(0, 200)
    yield `${event.data.name} :: ${name}: ${message}\n`
  }
}
