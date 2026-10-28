export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    yield `${JSON.stringify({ event: event.type, file: data.file, name: data.name, nesting: data.nesting,
      line: data.line, column: data.column, type: data.details?.type, skip: Boolean(data.skip),
      todo: Boolean(data.todo), error: data.details?.error?.message })}\n`;
  }
}
