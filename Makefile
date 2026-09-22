BIN := flash

.PHONY: fmt vet test build run up down logs clean

fmt:
	gofmt -l -w .

vet:
	go vet ./...

test:
	go test ./...
	node --test static/

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BIN) .

run: build
	PORT=$${PORT:-8080} BASE_PATH=$${BASE_PATH:-} ./$(BIN)

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

clean:
	rm -f $(BIN)
