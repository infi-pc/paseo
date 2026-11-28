#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/clonefile.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: clonefile-darwin <src> <dst>\n");
    return 2;
  }
  if (clonefile(argv[1], argv[2], CLONE_NOFOLLOW) != 0) {
    fprintf(stderr, "clonefile(%s, %s): %s (errno=%d)\n", argv[1], argv[2], strerror(errno), errno);
    return 1;
  }
  return 0;
}
