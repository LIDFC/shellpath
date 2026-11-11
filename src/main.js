// Точка входа в браузере.
import './commands/index.js';
import { S, meta, loadProgress } from './core/state.js';
import { buildWorld } from './levels/index.js';
import { enterLevel } from './core/session.js';
import { startUI, focusTerminal } from './ui/app.js';

loadProgress();
buildWorld();
startUI();
const m = meta(S.cur);
enterLevel(m.block, m.n, { fresh: true });
focusTerminal();
