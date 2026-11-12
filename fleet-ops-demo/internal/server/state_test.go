package server

import (
	"testing"
	"time"
)

func TestSeededActivityShowsInTruckHistory(t *testing.T) {
	a, _ := newTestApp(t, &fake{})
	a.seedActivity(time.Now())

	page, err := a.truckPage("quinn", "acme", "acme-hou-01")
	if err != nil {
		t.Fatal(err)
	}
	history, ok := page["history"].([]historyRow)
	if !ok || len(history) != 1 {
		t.Fatalf("history = %#v, want one seeded entry", page["history"])
	}
	if got := history[0]; got.Kind != "Dispatched on Houston → Dallas" || got.By != "Quinn Ellis" {
		t.Errorf("history[0] = %+v", got)
	}

	page, err = a.truckPage("quinn", "acme", "acme-dal-03")
	if err != nil {
		t.Fatal(err)
	}
	if history, _ := page["history"].([]historyRow); len(history) != 0 {
		t.Errorf("unseeded truck history = %+v, want none", history)
	}
}
