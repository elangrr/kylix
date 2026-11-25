// Package adaptertest is a TEST-ONLY integration suite: it runs the
// adapters in r/adapters against the real collection realms from the
// testnet and the real Kylix. Never deploy it.
//
// The collection realms are third-party code and are not in this repo.
// `make deps` downloads them from the testnet into the gitignored .gnohome
// module cache; then `make integration` runs this package.
package adaptertest
