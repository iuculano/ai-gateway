import { plugin, Transpiler } from 'bun';
import { compileModule } from 'svelte/compiler';

// Every test runs with the reader west of Greenwich. It is set here, before
// any module loads, because a formatter takes its zone when it is built and
// the format module builds its own once for every test file that imports it.
//
// Seven or eight hours behind UTC, midnight UTC is still the evening before,
// which is where a date shown in the wrong zone gives itself away.
process.env.TZ = 'America/Los_Angeles';

// Modules that use runes are compiled the way the app compiles them, so that
// tests run the real state classes with their reactivity and not stand-ins.
plugin({
  name: 'svelte-runes',
  setup(build): void {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const source = new Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text());
      const compiled = compileModule(source, { filename: path, generate: 'client' });

      return { contents: compiled.js.code, loader: 'js' };
    });
  },
});
