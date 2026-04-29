# Vishrun

Vishrun is a Lumiverse Spindle extension that renders embedded HTML/CSS/JS widgets from SillyTavern character cards (`regex_scripts`).

## What it does

SillyTavern character cards can carry embedded UI widgets in a `regex_scripts` field — small HTML/CSS/JS payloads that render inside chat messages when the AI emits a trigger such as `【FOO】` or `<TAG>...data...</TAG>`. Lumiverse imports these cards but does not interpret `regex_scripts`, so the widgets remain inert. Vishrun fills that gap.

When the active character has `regex_scripts` entries, Vishrun watches messages as they render. On a placeholder trigger, it replaces the trigger inline with the widget — a sandboxed iframe if the payload contains `<script>`, otherwise a styled `<div>`. On a paired-tag trigger, it strips the tag from view and renders the widget with the captured data substituted via `$1..$N` backreferences. Rendering is idempotent: reloads, swipes, and message edits all re-render cleanly without modifying the persisted chat history.

The engine is card-agnostic. No card-specific code lives in the extension; any card whose `regex_scripts` use the supported feature subset (placeholders or paired tags, raw regex source, `$0`/`$N` backreferences, self-contained HTML/CSS/JS replaceString) works without modification.

## Status

MVP. Tested end-to-end on a live Lumiverse install with two cards: **Vavesta Empress** (placeholder widgets including one with embedded JS executing inside the iframe sandbox, plus a paired-tag widget with single-capture substitution) and **Xiao Gu** (paired-tag widget with twelve capture groups, validating multi-group substitution and generality across cards).

## Not yet supported

- **MVU (`MagVarUpdate`).** Cards that depend on `<UpdateVariable>` parsing, `_.set()` execution, or persistent `stat_data` will not have reactive widget updates.
- **JS-Slash-Runner global shims (`setChatMessages` and friends).** Widget button handlers that call these globals are currently visual-only; clicks are received but the global handlers fall through to `console.log`.
- **Prompt-side substitution (`placement: 1`).** Vishrun operates on the render side only and does not modify the prompt sent to the LLM.

## Install

- Open Lumiverse, go to Extensions, click Add extensions, choose Install from source, paste this repo's GitHub URL, and click Install from source. Once installed, enable the extension and refresh the browser tab.
- For local development, clone the repo to Lumiverse/data/extensions/vishrun/repo and follow the standard Spindle build flow.
