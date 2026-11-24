# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.

# NODE_BIN: optional Node bin dir (^22.18 or >= 24.11, required by the fixture's Babel 8; default: `node` on PATH).
NODE_BIN ?=
export PATH := $(if $(NODE_BIN),$(NODE_BIN):,)$(PATH)
JESTDEPS := tests/hunt_fixtures/jestdeps
VERIFYDEPS := tests/verify_fixtures
SKILL_SCRIPTS := .claude/skills/hunt/scripts

.PHONY: self-test jest-deps verify-deps lint

self-test: jest-deps verify-deps
	python3 -m pytest -q tests

jest-deps: $(JESTDEPS)/node_modules/.package-lock.json

$(JESTDEPS)/node_modules/.package-lock.json: $(JESTDEPS)/package.json $(JESTDEPS)/package-lock.json
	cd $(JESTDEPS) && npm ci --no-audit --no-fund --loglevel=error

# Playwright library only; browsers come from the machine (CI runs `npx playwright install --with-deps chromium`).
verify-deps: $(VERIFYDEPS)/node_modules/.package-lock.json

$(VERIFYDEPS)/node_modules/.package-lock.json: $(VERIFYDEPS)/package.json $(VERIFYDEPS)/package-lock.json
	cd $(VERIFYDEPS) && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error

lint:
	ruff check .
	mypy --ignore-missing-imports $(SKILL_SCRIPTS) .claude/skills/verify/scripts/pr_server.py eval/mine_rules.py eval/mine_controls.py
	shellcheck scripts/*.sh $(SKILL_SCRIPTS)/*.sh
	node --check .claude/skills/verify/scripts/verify_ui.mjs
