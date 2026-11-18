# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.

# NODE_BIN: optional Node >= 20 bin dir for the Jest fixture (default: `node` on PATH).
NODE_BIN ?=
export PATH := $(if $(NODE_BIN),$(NODE_BIN):,)$(PATH)
JESTDEPS := tests/hunt_fixtures/jestdeps
SKILL_SCRIPTS := .claude/skills/hunt/scripts

.PHONY: self-test jest-deps lint

self-test: jest-deps
	python3 -m pytest -q tests

jest-deps: $(JESTDEPS)/node_modules/.package-lock.json

$(JESTDEPS)/node_modules/.package-lock.json: $(JESTDEPS)/package.json $(JESTDEPS)/package-lock.json
	cd $(JESTDEPS) && npm ci --no-audit --no-fund --loglevel=error

lint:
	ruff check .
	mypy --ignore-missing-imports $(SKILL_SCRIPTS)
	shellcheck scripts/*.sh $(SKILL_SCRIPTS)/*.sh
