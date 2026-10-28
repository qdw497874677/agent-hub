import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packAsset } from './asset.ts';

const text = (s: string) => new TextEncoder().encode(s);
const skill = (extra: { path: string; data: Uint8Array }) => [{ path: 'SKILL.md', data: text('---\nname: a\ndescription: b\n---\n') }, extra];
const message = async (files: { path: string; data: Uint8Array }[]) => {
  const packed = await packAsset('skill', files);
  return packed.ok ? null : packed.error.message;
};

test('资产校验：拒收可执行文件（扩展名 / ELF / PE / Mach-O 魔数），脚本照收', async () => {
  assert.equal(await message(skill({ path: 'tools/run.exe', data: text('x') })), '不收可执行文件：tools/run.exe');
  assert.equal(await message(skill({ path: 'lib/x.so', data: text('x') })), '不收可执行文件：lib/x.so');
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  assert.equal(await message(skill({ path: 'scripts/tool', data: elf })), '不收可执行文件：scripts/tool（是编译好的二进制程序）');
  assert.match((await message(skill({ path: 'a/b', data: new Uint8Array([0x4d, 0x5a, 0x90]) }))) ?? '', /二进制程序/);
  assert.match((await message(skill({ path: 'a/m', data: new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7]) }))) ?? '', /二进制程序/);
  assert.equal(await message(skill({ path: 'scripts/run.py', data: text('#!/usr/bin/env python3\nprint(1)\n') })), null);
  assert.equal(await message(skill({ path: 'scripts/run.sh', data: text('#!/bin/sh\necho hi\n') })), null);
});

test('资产校验：hooks / bin 在根上、hooks / .claude-plugin 在任何一层都拒；大小超限说清上限', async () => {
  assert.match((await message(skill({ path: 'bin/x', data: text('x') }))) ?? '', /不能带 bin\//);
  assert.match((await message(skill({ path: 'hooks/pre.sh', data: text('x') }))) ?? '', /不能带 hooks\//);
  assert.equal(await message(skill({ path: 'extra/hooks/pre.sh', data: text('x') })), '不能带 hooks/ 目录：extra/hooks/pre.sh（钩子 / 插件机制不在资产中心的范围内）');
  assert.match((await message(skill({ path: '.claude-plugin/plugin.json', data: text('{}') }))) ?? '', /\.claude-plugin/);
  assert.equal(await message(skill({ path: 'notes/hooks.md', data: text('ok') })), null);
  assert.equal(await message(skill({ path: 'big.txt', data: new Uint8Array(1024 * 1024 + 1) })), '文件太大：big.txt（单个文件上限 1 MB）');
});
