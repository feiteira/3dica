// The Customizer reader (OpenSCAD User Manual, "Customizer"): which top-level assignments are parameters, their
// widgets, tabs and descriptions as 3Dica ParamDefs, and editing a default in the source.
import { describe, expect, test } from 'vitest'
import { extractParams, overrideValues, setParamDefault } from '../../src/openscad/customizer'
import { interpret } from '../../src/openscad/interp'
import { paramDefProblems } from '../../src/core/params'

const SRC = `// Customizable box
include <lib.scad>

/* [Size] */
// Width of the box
width = 40; // [10:100]
// Depth
depth = 30.5; // [10:0.5:80]
height = 20;  // [50]
wall = 2; // .5
/* [Options] */
// Number of holes
holes = 2; // [0, 1, 2, 3]
size = 20; // [10:Small, 20:Medium, 30:Large]
style = "round"; // [round, square, hex]
shape = "S"; // [S:Small, M:Medium, L:Large]
lid = true;
label = "Box";
pos = [1, 2, 3];
offset = -5;
area = width * depth;
2D = 1;
undefined = 4;
$fn = 32;
function half(x) = x / 2;
module mark() cube();
late = 3; // [1:5]
/* [Hidden] */
eps = 0.01;
module box() { cube([width, depth, height]); }
after = 5;
`

describe('extractParams', () => {
  const { params, skipped } = extractParams(SRC)
  const p = (name: string) => params.find((x) => x.name === name)

  test('sliders, spinbox step, dropdowns and checkboxes', () => {
    expect(p('width')).toEqual({ name: 'width', line: 6, description: 'Width of the box', group: 'Size', type: 'number', default: 40, min: 10, max: 100 })
    expect(p('depth')).toMatchObject({ type: 'number', default: 30.5, min: 10, step: 0.5, max: 80, description: 'Depth' })
    expect(p('height')).toMatchObject({ type: 'number', default: 20, min: 0, max: 50 })
    expect(p('wall')).toMatchObject({ type: 'number', default: 2, step: 0.5 })
    expect(p('holes')).toMatchObject({ type: 'choice', default: '2', options: ['0', '1', '2', '3'], group: 'Options', description: 'Number of holes' })
    expect(p('size')).toMatchObject({ type: 'choice', default: 'Medium', options: ['Small', 'Medium', 'Large'] })
    expect(p('style')).toMatchObject({ type: 'choice', default: 'round', options: ['round', 'square', 'hex'] })
    expect(p('shape')).toMatchObject({ type: 'choice', default: 'Small', options: ['Small', 'Medium', 'Large'] })
    expect(p('lid')).toMatchObject({ type: 'boolean', default: true })
    expect(p('offset')).toMatchObject({ type: 'number', default: -5 })
    expect(p('$fn')).toMatchObject({ type: 'number', default: 32 })
  })

  test('function definitions and modules without a body do not end the parameters; the first { does', () => {
    expect(p('late')).toMatchObject({ type: 'number', default: 3, min: 1, max: 5, line: 27 })
    expect(params.map((x) => x.name)).not.toContain('after')
  })

  test('what cannot be a parameter is listed with the reason', () => {
    expect(skipped).toEqual([
      { name: 'label', line: 18, reason: 'a string without options' },
      { name: 'pos', line: 19, reason: 'a vector' },
      { name: 'area', line: 21, reason: 'an expression' },
      { name: '2D', line: 22, reason: 'not a name 3Dica parameters can use' },
      { name: 'undefined', line: 23, reason: 'a reserved word in 3Dica' },
      { name: 'eps', line: 29, reason: 'in the Hidden tab' },
    ])
  })

  test('the parameters are valid 3Dica ParamDefs', () => {
    expect(paramDefProblems(params)).toEqual([])
  })

  test('a description must start at the left column and be on the line just above', () => {
    const r = extractParams('  // indented\na = 1;\n// right above\n\nb = 2;\n// [1:2]\nc = 3;\n// ok\nd = 4;')
    expect(r.params.map((x) => [x.name, x.description])).toEqual([['a', undefined], ['b', undefined], ['c', undefined], ['d', 'ok']])
  })

  test('a dropdown value that is not among the items becomes the first option', () => {
    expect(extractParams('n = 5; // [1, 2, 3]').params[0]).toMatchObject({ type: 'choice', default: '5', options: ['5', '1', '2', '3'] })
    expect(extractParams('s = "x"; // [a:A, b:B]').params[0]).toMatchObject({ type: 'choice', default: 'x', options: ['x', 'A', 'B'] })
  })

  test('repeated labels are told apart by their value; the last assignment of a name wins', () => {
    expect(extractParams('n = 2; // [1:One, 2:One, 3:Three, 3:Three]').params[0]).toMatchObject({ options: ['One', 'One (2)', 'Three'], default: 'One (2)' })
    expect([...overrideValues('n = 2; // [1:One, 2:One]', { n: 'One (2)' })]).toEqual([['n', 2]])
    expect(extractParams('a = 1;\na = 2; // [0:5]').params).toEqual([{ name: 'a', line: 2, type: 'number', default: 2, min: 0, max: 5 }])
  })

  test('never throws: broken or odd sources give what could be read', () => {
    expect(extractParams('a = 1;\nb = "never closed').params.map((x) => x.name)).toEqual(['a'])
    expect(extractParams('a = 1; /* never closed').params.map((x) => x.name)).toEqual(['a'])
    expect(extractParams('')).toEqual({ params: [], skipped: [] })
    expect(extractParams('a = ;\nb = 2;').params.map((x) => x.name)).toEqual(['b'])
    expect(extractParams(undefined as unknown as string)).toEqual({ params: [], skipped: [] })
  })

  test('the tab comment may have spaces; [Global] is just a tab name', () => {
    expect(extractParams('/*[ Slider ]*/\na = 1;\n/* [Global] */\nb = 2;').params.map((x) => x.group)).toEqual(['Slider', 'Global'])
  })
})

describe('setParamDefault', () => {
  test('changes only the literal, keeping comments and layout', () => {
    expect(setParamDefault(SRC, 'width', 55.25)!.split('\n')[5]).toBe('width = 55.25; // [10:100]')
    expect(setParamDefault(SRC, 'offset', -0.1)!.split('\n')[19]).toBe('offset = -0.1;')
    expect(setParamDefault(SRC, 'lid', false)!.split('\n')[16]).toBe('lid = false;')
    const out = setParamDefault(SRC, 'height', 7)!
    expect(out.replace('height = 7;', 'height = 20;')).toBe(SRC)
  })
  test('a choice writes the value of the chosen option', () => {
    expect(setParamDefault(SRC, 'size', 'Large')!.split('\n')[13]).toBe('size = 30; // [10:Small, 20:Medium, 30:Large]')
    expect(setParamDefault(SRC, 'holes', '3')!.split('\n')[12]).toBe('holes = 3; // [0, 1, 2, 3]')
    expect(setParamDefault(SRC, 'shape', 'Medium')!.split('\n')[15]).toBe('shape = "M"; // [S:Small, M:Medium, L:Large]')
    expect(setParamDefault('s = "a"; // [a, b\\"c]', 's', 'b\\"c')).toBe('s = "b\\\\\\"c"; // [a, b\\"c]')
  })
  test('numbers are written the shortest way that reads back the same', () => {
    for (const v of [0.1, 1 / 3, 1e21, 5e-7, -0.5, 100]) {
      const out = setParamDefault('x = 1;', 'x', v)!
      expect(interpret(`${out}\necho(x == ${String(v)});`).messages[0].text).toBe('true')
      expect(extractParams(out).params[0].default).toBe(v)
    }
    expect(setParamDefault('x = 1;', 'x', 0.1)).toBe('x = 0.1;')
  })
  test('null when it is not a parameter or the value does not fit', () => {
    expect(setParamDefault(SRC, 'nope', 1)).toBeNull()
    expect(setParamDefault(SRC, 'area', 1)).toBeNull()
    expect(setParamDefault(SRC, 'eps', 1)).toBeNull()
    expect(setParamDefault(SRC, 'width', 'wide')).toBeNull()
    expect(setParamDefault(SRC, 'width', Infinity)).toBeNull()
    expect(setParamDefault(SRC, 'size', 'Huge')).toBeNull()
    expect(setParamDefault(SRC, 'lid', 1)).toBeNull()
  })
})

describe('overrideValues', () => {
  test('choice options map back to their OpenSCAD values', () => {
    expect([...overrideValues(SRC, { size: 'Large', holes: '3', style: 'hex', shape: 'Medium', width: 12, nope: 'x' })]).toEqual([
      ['size', 30], ['holes', 3], ['style', 'hex'], ['shape', 'M'], ['width', 12], ['nope', 'x'],
    ])
  })
})
