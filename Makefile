.PHONY: demo\:voter ios\:build setup circuits\:build program\:build program\:test test e2e demo\:up demo\:devnet demo\:hosted demo\:start demo\:stop lint clean

setup:
	./scripts/setup.sh

circuits\:build:
	pnpm circuits:build

program\:build:
	pnpm program:build

program\:test:
	pnpm program:test

test:
	cargo test -p zk_election
	pnpm test
	cd ios/PassportKit && swift test

ios\:build:
	cd ios && xcodegen generate && xcodebuild -project ZKElection.xcodeproj -scheme PassportProbe \
	  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build | tail -3

e2e:
	pnpm e2e

lint:
	cargo fmt --all --check
	cargo clippy -p zk_election -- -D warnings
	pnpm typecheck

demo\:up:
	./scripts/demo-up.sh

demo\:devnet:
	./scripts/demo-devnet.sh

demo\:start:
	./scripts/demo-start.sh

demo\:stop:
	./scripts/demo-stop.sh

demo\:hosted:
	./scripts/demo-hosted.sh

demo\:voter:
	pnpm demo:voter

clean:
	rm -rf target circuits/build node_modules */node_modules packages/*/node_modules test-ledger
