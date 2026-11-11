// Подключает все команды. Команды уровней (gatekeeper, harden-check, labcheck) регистрируются в src/levels/*.
import './basic.js';
import './files.js';
import './ssh.js';
import './net.js';
import '../levels/index.js';

export { C } from './registry.js';
