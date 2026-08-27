#!/usr/bin/env node
import { mainLockCommand } from '../dist/policy/lock-command.js';

process.exitCode = await mainLockCommand(process.argv.slice(2), process.cwd());
