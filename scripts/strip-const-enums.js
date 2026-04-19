#!/usr/bin/env node

// Post-build step: strip `const` from `const enum` in .d.ts files so
// downstream consumers with isolatedModules can use our enums normally.
// We keep `const enum` in source for inlined values internally;
// preserveConstEnums in tsconfig ensures the runtime objects still exist in .js.
//
// Applies to every built `dist/` in the monorepo: root + each workspace
// package. Uses the TypeScript transformer API to rewrite the AST.

import ts from "typescript"
import { readFileSync, writeFileSync } from "node:fs"
import { globSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dirname, "..")

const files = globSync(
  ["dist/**/*.d.{ts,cts,mts}", "packages/*/dist/**/*.d.{ts,cts,mts}"],
  { cwd: repoRoot },
).map((f) => join(repoRoot, f))

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })

/** @returns {ts.TransformerFactory<ts.SourceFile>} */
function stripConstEnumTransformer(context) {
  return (sourceFile) => {
    function visit(node) {
      if (ts.isEnumDeclaration(node) && node.modifiers) {
        const hasConst = node.modifiers.some(
          (m) => m.kind === ts.SyntaxKind.ConstKeyword,
        )
        if (hasConst) {
          const filtered = node.modifiers.filter(
            (m) => m.kind !== ts.SyntaxKind.ConstKeyword,
          )
          return context.factory.updateEnumDeclaration(
            node,
            filtered,
            node.name,
            node.members,
          )
        }
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(sourceFile, visit)
  }
}

let patched = 0

for (const file of files) {
  const src = readFileSync(file, "utf-8")
  const sourceFile = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  const hasConstEnum = sourceFile.statements.some(
    (s) =>
      ts.isEnumDeclaration(s) &&
      s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ConstKeyword),
  )
  if (!hasConstEnum) continue

  const result = ts.transform(sourceFile, [stripConstEnumTransformer])
  const transformed = result.transformed[0]
  const out = printer.printFile(transformed)
  result.dispose()

  writeFileSync(file, out, "utf-8")
  patched++
}

if (patched > 0) {
  console.log(`strip-const-enums: patched ${patched} .d.ts file(s)`)
}
