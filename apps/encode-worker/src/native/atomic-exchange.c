#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: rip-dvd-atomic-exchange FIRST SECOND\n", stderr);
    return 64;
  }

#if defined(__linux__)
  const int result =
      renameat2(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE);
#elif defined(__APPLE__)
  const int result =
      renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP);
#else
#error "Atomic path exchange is unsupported on this platform"
#endif

  if (result == 0) {
    return 0;
  }
  fprintf(stderr, "atomic exchange failed: %s\n", strerror(errno));
  return 1;
}
