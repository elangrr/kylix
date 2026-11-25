// Package living is a test-only Sinopia3 engine, never deployed: a living engine: its manifest says Render depends on the token's transfer history.
// It draws the Genesis art, so registering it must be signed by the
// Genesis author (core refuses a second engine with the same art otherwise).
package living

import (
	art "gno.land/p/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia/art/genesis/v1"
	"gno.land/p/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia/engine/v1"
	"gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core"
)

// Author claims the engine in core (core.ClaimEngine).
const Author = address("g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06")

type impl struct{}

func (impl) Manifest() engine.Manifest {
	m := art.Manifest()
	m.Name = "Kylix Test Living"
	m.Author = Author
	m.Living = true
	return m
}

func (impl) ValidateParams(params string) error    { return art.ValidateParams(params) }
func (impl) Traits(in engine.Input) []engine.Trait { return art.Traits(in) }
func (impl) Render(in engine.Input) string         { return art.Render(in) }

// Register registers the engine with core from this realm.
func Register(cur realm) string { return core.RegisterEngine(cross(cur), impl{}) }
