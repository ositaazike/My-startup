import fs from 'node:fs/promises';
import path from 'node:path';
import Markdown from 'markdown-to-jsx';

async function getSpecification() {
  const specPath = path.join(process.cwd(), 'docs', 'fuelguard-africa-spec.md');
  return fs.readFile(specPath, 'utf8');
}

export default async function FuelGuardAfricaSpecPage() {
  const content = await getSpecification();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto w-full max-w-6xl px-6 py-10 sm:px-10">
        <header className="mb-10 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-lg">
          <p className="mb-2 text-sm uppercase tracking-[0.2em] text-cyan-400">FuelGuard Africa</p>
          <h1 className="text-3xl font-bold sm:text-4xl">Production Architecture & Implementation Specification</h1>
          <p className="mt-3 text-slate-300">
            Offline-first IoT + SaaS blueprint for fuel retail operations in Nigeria.
          </p>
        </header>

        <article className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6 leading-7 shadow-lg">
          <Markdown
            options={{
              overrides: {
                h1: { props: { className: 'mt-6 text-3xl font-bold text-cyan-300' } },
                h2: { props: { className: 'mt-8 text-2xl font-semibold text-cyan-200' } },
                h3: { props: { className: 'mt-6 text-xl font-semibold text-cyan-100' } },
                p: { props: { className: 'text-slate-200' } },
                ul: { props: { className: 'list-disc pl-6 space-y-1 text-slate-200' } },
                ol: { props: { className: 'list-decimal pl-6 space-y-1 text-slate-200' } },
                li: { props: { className: 'text-slate-200' } },
                code: {
                  props: {
                    className: 'rounded bg-slate-800 px-1 py-0.5 text-sm text-cyan-100',
                  },
                },
                pre: {
                  props: {
                    className:
                      'my-4 overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 text-sm leading-6 text-slate-100',
                  },
                },
                table: {
                  props: {
                    className: 'my-4 w-full border-collapse overflow-hidden rounded-lg border border-slate-700',
                  },
                },
                thead: { props: { className: 'bg-slate-800' } },
                th: { props: { className: 'border border-slate-700 px-3 py-2 text-left text-slate-100' } },
                td: { props: { className: 'border border-slate-700 px-3 py-2 text-slate-200' } },
              },
            }}
          >
            {content}
          </Markdown>
        </article>
      </div>
    </main>
  );
}
