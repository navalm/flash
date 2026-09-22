# Multi-stage Go build -> distroless static runtime.
# ---- build stage ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY static/ ./static/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/flash .

# ---- runtime stage ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/flash /flash
ENV PORT=8080
EXPOSE 8080
EXPOSE 3478/udp
USER nonroot:nonroot
ENTRYPOINT ["/flash"]
