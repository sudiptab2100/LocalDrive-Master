#include <errno.h>
#include <stdio.h>

/* Node does not expose renamex_np. Unlike check-then-rename or mv -n, this
 * operation cannot replace an entry created concurrently at the destination. */
int main(int argc, char *argv[]) {
  if (argc != 3) return 64;
  if (renamex_np(argv[1], argv[2], RENAME_EXCL) == 0) return 0;
  fprintf(stderr, "%d\n", errno);
  return 1;
}
