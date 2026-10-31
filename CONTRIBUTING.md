# Contributing

Use Node 24.13+, install with npm ci --ignore-scripts, install OPA and run npm run verify. Keep dependencies locked and CI actions pinned to full commit hashes. Submit focused pull requests with verification evidence. Never add cloud credentials or execute infrastructure from pull-request inputs. New adapters must distinguish mocked, offline and live validation.
