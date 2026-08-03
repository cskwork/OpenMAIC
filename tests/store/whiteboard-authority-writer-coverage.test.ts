import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PRODUCTION_ROOTS = [
  'app',
  'components',
  'eval',
  'lib',
  'packages',
  'render-service',
] as const;
const NON_PRODUCTION_ROOTS = new Set([
  '.codegraph',
  '.git',
  '.github',
  '.next',
  'assets',
  'data',
  'e2e',
  'node_modules',
  'public',
  'scripts',
  'tests',
]);

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(fullPath));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) result.push(fullPath);
  }
  return result;
}

function parseSource(source: string, fileName = 'fixture.ts'): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function containsObjectProperty(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) &&
      names.has(propertyNameText(current.name) ?? '')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isStoreSetter(call: ts.CallExpression): boolean {
  const expression = call.expression;
  return (
    (ts.isIdentifier(expression) &&
      (expression.text === 'set' || expression.text === 'setState')) ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 'setState')
  );
}

function mutationKind(call: ts.CallExpression, aliases: ReadonlySet<string>): string | null {
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].includes(
      call.expression.name.text,
    ) &&
    isWhiteboardCollection(call.expression.expression, aliases)
  ) {
    return 'whiteboard-array-mutation';
  }
  if (!isStoreSetter(call) || call.arguments.length === 0) return null;
  const argument = call.arguments[0];
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText().includes('useStageStore') &&
    containsObjectProperty(argument, new Set(['stage']))
  ) {
    return 'whole-stage-write';
  }
  if (argument.getText().includes('clearedStageState')) return 'whole-stage-write';
  if (argument.getText().includes('initialState')) return 'visibility-write';
  if (containsObjectProperty(argument, new Set(['whiteboardOpen']))) return 'visibility-write';
  if (containsObjectProperty(argument, new Set(['whiteboard']))) return 'whiteboard-write';
  if (containsObjectProperty(argument, new Set(['stage']))) return 'whole-stage-write';
  return null;
}

function assignmentMutationKind(node: ts.BinaryExpression): string | null {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const target = node.left.getText();
  if (/\.stage$/.test(target)) return 'whole-stage-assignment';
  if (/\.whiteboardOpen$/.test(target)) return 'visibility-assignment';
  if (/\.whiteboard(?:\??\.\[.*\])?$/.test(target)) return 'whiteboard-assignment';
  return null;
}

function rawWriterInventory(source: string, fileName = 'fixture.ts'): string[] {
  const sourceFile = parseSource(source, fileName);
  const aliases = collectWhiteboardAliases(sourceFile);
  const results: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const kind = mutationKind(node, aliases);
      if (kind) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        results.push(`${fileName}:${line}:${kind}`);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const kind = assignmentMutationKind(node);
      if (kind) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        results.push(`${fileName}:${line}:${kind}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function collectWhiteboardAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer) {
          const initializer = node.initializer;
          const isAlias =
            (ts.isPropertyAccessExpression(initializer) &&
              initializer.name.text === 'whiteboard') ||
            (ts.isIdentifier(initializer) && aliases.has(initializer.text));
          if (isAlias && !aliases.has(node.name.text)) {
            aliases.add(node.name.text);
            changed = true;
          }
        } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const sourceName = element.propertyName
              ? propertyNameText(element.propertyName)
              : element.name.text;
            if (sourceName === 'whiteboard') {
              if (!aliases.has(element.name.text)) {
                aliases.add(element.name.text);
                changed = true;
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return aliases;
}

function isWhiteboardCollection(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  return (
    (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'whiteboard') ||
    (ts.isIdentifier(unwrapped) && aliases.has(unwrapped.text))
  );
}

function activeSelectorInventory(source: string, fileName = 'fixture.ts'): string[] {
  const sourceFile = parseSource(source, fileName);
  const aliases = collectWhiteboardAliases(sourceFile);
  const results: string[] = [];
  const record = (node: ts.Node, kind: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    results.push(`${fileName}:${line}:${kind}`);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isNumericLiteral(node.argumentExpression) &&
      node.argumentExpression.text === '0' &&
      isWhiteboardCollection(node.expression, aliases)
    ) {
      record(node, 'first-board-selector');
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isBinaryExpression(node.argumentExpression) &&
      node.argumentExpression.operatorToken.kind === ts.SyntaxKind.MinusToken &&
      ts.isPropertyAccessExpression(node.argumentExpression.left) &&
      node.argumentExpression.left.name.text === 'length' &&
      node.argumentExpression.left.expression.getText() === node.expression.getText() &&
      ts.isNumericLiteral(node.argumentExpression.right) &&
      node.argumentExpression.right.text === '1' &&
      isWhiteboardCollection(node.expression, aliases)
    ) {
      record(node, 'last-board-selector');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'at' &&
      node.arguments.length === 1 &&
      isWhiteboardCollection(node.expression.expression, aliases)
    ) {
      const index = node.arguments[0];
      if (ts.isNumericLiteral(index) && index.text === '0') {
        record(node, 'first-board-selector');
      } else if (
        ts.isPrefixUnaryExpression(index) &&
        index.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(index.operand) &&
        index.operand.text === '1'
      ) {
        record(node, 'last-board-selector');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function productionInventory(collector: (source: string, fileName: string) => string[]): string[] {
  const results: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of sourceFiles(path.join(process.cwd(), root))) {
      const relative = path.relative(process.cwd(), file);
      if (relative === 'lib/store/whiteboard-environment-authority.ts') continue;
      results.push(...collector(fs.readFileSync(file, 'utf8'), relative));
    }
  }
  return results.sort();
}

function enclosingWriterOwner(node: ts.Node): {
  owner?: ts.Node;
  helperName?: string;
} {
  let current: ts.Node | undefined = node.parent;
  let helperName: string | undefined;
  while (current) {
    if (ts.isFunctionLike(current)) {
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        ts.isPropertyAssignment(current.parent) &&
        propertyNameText(current.parent.name) === 'write'
      ) {
        current = current.parent.parent;
        continue;
      }
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        ts.isVariableDeclaration(current.parent)
      ) {
        if (ts.isIdentifier(current.parent.name)) helperName ??= current.parent.name.text;
        current = current.parent.parent;
        continue;
      }
      return { owner: current, helperName };
    }
    current = current.parent;
  }
  return { helperName };
}

function transactionCallForWriteProperty(
  property: ts.PropertyAssignment,
): ts.CallExpression | null {
  const element = property.parent;
  if (!ts.isObjectLiteralExpression(element)) return null;
  const array = element.parent;
  if (!ts.isArrayLiteralExpression(array)) return null;
  const writes = array.parent;
  if (
    !ts.isPropertyAssignment(writes) ||
    propertyNameText(writes.name) !== 'writes' ||
    writes.initializer !== array
  ) {
    return null;
  }
  const config = writes.parent;
  if (!ts.isObjectLiteralExpression(config)) return null;
  const call = config.parent;
  if (
    !ts.isCallExpression(call) ||
    call.arguments[0] !== config ||
    !ts.isPropertyAccessExpression(call.expression) ||
    (call.expression.name.text !== 'transact' && call.expression.name.text !== 'transactRevisioned')
  ) {
    return null;
  }
  return call;
}

function lexicalOwner(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

function writerBelongsToAuthorityAdapter(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isPropertyAssignment(current.parent) &&
      propertyNameText(current.parent.name) === 'write' &&
      current.parent.initializer === current
    ) {
      return transactionCallForWriteProperty(current.parent) !== null;
    }
    current = current.parent;
  }

  const { owner, helperName } = enclosingWriterOwner(node);
  if (!owner || !helperName) return false;
  const scope = lexicalOwner(owner);
  let approved = false;
  const visit = (current: ts.Node) => {
    if (approved) return;
    if (
      ts.isPropertyAssignment(current) &&
      propertyNameText(current.name) === 'write' &&
      ts.isIdentifier(current.initializer) &&
      current.initializer.text === helperName &&
      transactionCallForWriteProperty(current) !== null
    ) {
      approved = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(scope);
  return approved;
}

function unapprovedWriterInventory(source: string, fileName = 'fixture.ts'): string[] {
  const sourceFile = parseSource(source, fileName);
  const aliases = collectWhiteboardAliases(sourceFile);
  const results: string[] = [];
  const inspect = (node: ts.CallExpression | ts.BinaryExpression, kind: string) => {
    if (writerBelongsToAuthorityAdapter(node)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    results.push(`${fileName}:${line}:${kind}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const kind = mutationKind(node, aliases);
      if (kind) inspect(node, kind);
    }
    if (ts.isBinaryExpression(node)) {
      const kind = assignmentMutationKind(node);
      if (kind) inspect(node, kind);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

describe('whiteboard Authority writer inventory', () => {
  it('scans every current source root that imports the Stage or Canvas stores', () => {
    const uncoveredRoots: string[] = [];
    const covered = new Set<string>(PRODUCTION_ROOTS);
    for (const entry of fs.readdirSync(process.cwd(), { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        NON_PRODUCTION_ROOTS.has(entry.name) ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const importsDomainStore = sourceFiles(path.join(process.cwd(), entry.name)).some((file) =>
        /@\/lib\/store\/(?:stage|canvas)/u.test(fs.readFileSync(file, 'utf8')),
      );
      if (importsDomainStore && !covered.has(entry.name)) uncoveredRoots.push(entry.name);
    }
    expect(uncoveredRoots).toEqual([]);
  });

  it('keeps canonical active-board selection inside the Authority module', () => {
    expect(productionInventory(activeSelectorInventory)).toEqual([]);
  });

  it('tracks aliases and destructuring when detecting active-board selectors', () => {
    expect(
      activeSelectorInventory(
        [
          'const boards = stage.whiteboard;',
          'const alias = boards;',
          'const active = alias[0];',
          'const { whiteboard: destructured } = stage;',
          'const other = destructured[0];',
          'const last = alias[alias.length - 1];',
        ].join('\n'),
      ),
    ).toEqual([
      'fixture.ts:3:first-board-selector',
      'fixture.ts:5:first-board-selector',
      'fixture.ts:6:last-board-selector',
    ]);
  });

  it('keeps an exact AST inventory of reviewed raw whiteboard-domain writer callsites', () => {
    expect(productionInventory(rawWriterInventory)).toEqual([
      'eval/whiteboard-layout/state-manager.ts:62:visibility-write',
      'eval/whiteboard-layout/state-manager.ts:66:whole-stage-write',
      'lib/api/stage-api-mode.ts:104:whole-stage-write',
      'lib/api/stage-api-whiteboard.ts:119:whiteboard-write',
      'lib/api/stage-api-whiteboard.ts:148:whiteboard-write',
      'lib/api/stage-api-whiteboard.ts:225:whiteboard-write',
      'lib/api/stage-api-whiteboard.ts:263:whiteboard-write',
      'lib/api/stage-api-whiteboard.ts:301:whiteboard-write',
      'lib/api/stage-api-whiteboard.ts:63:whiteboard-write',
      'lib/classroom/load-classroom.ts:275:whole-stage-write',
      'lib/classroom/load-classroom.ts:488:whole-stage-write',
      'lib/store/canvas.ts:354:visibility-write',
      'lib/store/canvas.ts:493:visibility-write',
      'lib/store/stage.ts:1043:whole-stage-write',
      'lib/store/stage.ts:1092:whole-stage-write',
      'lib/store/stage.ts:236:whole-stage-write',
      'lib/store/stage.ts:518:whole-stage-write',
      'lib/store/stage.ts:684:whole-stage-write',
      'lib/store/stage.ts:969:whole-stage-write',
    ]);
  });

  it('detects opaque whole-stage replacements that do not mention whiteboard directly', () => {
    expect(rawWriterInventory('useStageStore.setState({ stage: replacement });')).toEqual([
      'fixture.ts:1:whole-stage-write',
    ]);
  });

  it('detects direct property assignment bypasses', () => {
    expect(
      rawWriterInventory(
        ['stage.whiteboard = replacement;', 'canvas.whiteboardOpen = true;'].join('\n'),
      ),
    ).toEqual(['fixture.ts:1:whiteboard-assignment', 'fixture.ts:2:visibility-assignment']);
  });

  it('detects direct whole-stage assignment bypasses', () => {
    expect(rawWriterInventory('state.stage = replacement;')).toEqual([
      'fixture.ts:1:whole-stage-assignment',
    ]);
  });

  it('detects whiteboard array mutations through aliases', () => {
    expect(
      rawWriterInventory(['const boards = stage.whiteboard;', 'boards.push(newBoard);'].join('\n')),
    ).toEqual(['fixture.ts:2:whiteboard-array-mutation']);
  });

  it('keeps every product writer family on an approved adapter path', () => {
    const requirements = [
      ['lib/action/engine.ts', 'this.stageAPI.whiteboard'],
      ['lib/action/client-effect-whiteboard.ts', 'createStageAPI'],
      ['components/whiteboard/whiteboard-history.tsx', 'stageAPI.whiteboard.update'],
      ['components/whiteboard/index.tsx', 'stageAPI.whiteboard'],
      ['lib/store/canvas.ts', 'authority.transact'],
      ['lib/store/stage.ts', 'authority?.transact'],
      ['lib/classroom/load-classroom.ts', 'authority?.transact'],
      ['lib/api/stage-api-mode.ts', 'authority.transact'],
    ] as const;

    for (const [file, requiredBoundary] of requirements) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, `${file} must remain routed through ${requiredBoundary}`).toContain(
        requiredBoundary,
      );
    }
  });

  it('associates every raw writer with its enclosing Authority adapter', () => {
    expect(productionInventory(unapprovedWriterInventory)).toEqual([]);
  });

  it('does not accept an unrelated file-level Authority call as writer authorization', () => {
    expect(
      unapprovedWriterInventory(
        [
          'function approved() { authority.transact({ writes: [] }); }',
          'function bypass() { useStageStore.setState({ stage: replacement }); }',
        ].join('\n'),
      ),
    ).toEqual(['fixture.ts:2:whole-stage-write']);
  });

  it('does not accept an unrelated transaction in the same function', () => {
    expect(
      unapprovedWriterInventory(
        [
          'function mixed() {',
          '  authority.transact({ writes: [] });',
          '  useStageStore.setState({ stage: replacement });',
          '}',
        ].join('\n'),
      ),
    ).toEqual(['fixture.ts:3:whole-stage-write']);
  });

  it('does not authorize a writer in a non-write transaction property', () => {
    expect(
      unapprovedWriterInventory(
        [
          'authority.transact({',
          '  label: useStageStore.setState({ stage: replacement }),',
          '  writes: [],',
          '});',
        ].join('\n'),
      ),
    ).toEqual(['fixture.ts:2:whole-stage-write']);
  });
});
