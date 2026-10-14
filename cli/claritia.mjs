#!/usr/bin/env node
import { main } from "./lib.mjs";

process.exitCode = await main(process.argv.slice(2));
