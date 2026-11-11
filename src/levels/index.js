// Все уровни и сборка мира.
import { BASIC } from './basic.js';
import { NET } from './net.js';
import { SSH } from './ssh.js';
import { buildBase } from '../worlds/base.js';
import { FS } from '../core/fs.js';

export const LEVELS = { basic: BASIC, net: NET, ssh: SSH };

let built = false;

/** Собрать основной мир: системные файлы и файлы уровней. Повторный вызов ничего не делает. */
export function buildWorld() {
  if (built) return;
  built = true;
  FS.root = FS.main;
  buildBase();
  for (const block of [BASIC, SSH]) for (const L of block) if (L.build) L.build();
}
