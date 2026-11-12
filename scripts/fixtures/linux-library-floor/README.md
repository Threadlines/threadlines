# Linux library floor fixtures

Real binaries for `scripts/lib/linux-library-floor.test.ts`. Both are
`fixture.cc`, built with `g++ -shared -fPIC -O1 -s` for x64:

- `built-on-ubuntu-24.04.so` (glibc 2.39, GCC 13): needs up to `GLIBC_2.34`.
- `built-on-ubuntu-26.04.so` (glibc 2.43, GCC 15): needs `GLIBC_2.42`.

To rebuild one:

```bash
docker run --rm --platform linux/amd64 -v "$PWD":/w -w /w ubuntu:24.04 sh -c \
  "apt-get update && apt-get install -y g++ && g++ -shared -fPIC -O1 -s -o built-on-ubuntu-24.04.so fixture.cc"
```

`readelf -V <file>` prints what each one needs.
