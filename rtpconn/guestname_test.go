package rtpconn

import (
	"testing"

	"github.com/leyvanah/sozvon/group"
)

func TestTokenUsername(t *testing.T) {
	str := func(s string) *string { return &s }
	name := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	users := map[string]group.UserDescription{"nick": {}}

	e2ee, err := group.Add("tokname-e2ee",
		&group.Description{E2EE: true, Users: users})
	if err != nil {
		t.Fatal(err)
	}
	defer group.Delete("tokname-e2ee")
	plain, err := group.Add("tokname-plain",
		&group.Description{Users: users})
	if err != nil {
		t.Fatal(err)
	}
	defer group.Delete("tokname-plain")

	tests := []struct {
		g        *group.Group
		in, want *string
	}{
		{e2ee, str("Анна Петрова"), nil}, // a guest's name is dropped
		{e2ee, str("nick"), str("nick")}, // the operator's own is kept
		{e2ee, nil, nil},
		{e2ee, str(""), str("")},
		{plain, str("Анна Петрова"), str("Анна Петрова")}, // as before
	}
	for _, tt := range tests {
		got := tokenUsername(tt.g, tt.in)
		if name(got) != name(tt.want) {
			t.Errorf("tokenUsername(%v, %q) = %q, want %q",
				tt.g.Name(), name(tt.in), name(got), name(tt.want))
		}
	}
}
