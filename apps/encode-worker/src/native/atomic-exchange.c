#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

enum { MAX_PATH_BYTES = 4096 };

static napi_value exchange_paths(napi_env environment,
                                 napi_callback_info callback) {
  size_t argument_count = 4;
  napi_value arguments[4];
  if (napi_get_cb_info(environment, callback, &argument_count, arguments, NULL,
                       NULL) != napi_ok ||
      argument_count != 4) {
    napi_throw_type_error(environment, NULL,
                          "Atomic exchange requires two paths and an identity");
    return NULL;
  }

  uint64_t expected_device;
  uint64_t expected_inode;
  bool device_lossless;
  bool inode_lossless;
  if (napi_get_value_bigint_uint64(environment, arguments[2],
                                   &expected_device, &device_lossless) !=
          napi_ok ||
      napi_get_value_bigint_uint64(environment, arguments[3], &expected_inode,
                                   &inode_lossless) != napi_ok ||
      !device_lossless || !inode_lossless) {
    napi_throw_type_error(environment, NULL,
                          "Atomic exchange identity is invalid");
    return NULL;
  }

  char paths[2][MAX_PATH_BYTES + 1];
  for (size_t index = 0; index < 2; index += 1) {
    napi_valuetype type;
    size_t path_length;
    if (napi_typeof(environment, arguments[index], &type) != napi_ok ||
        type != napi_string ||
        napi_get_value_string_utf8(environment, arguments[index], NULL, 0,
                                   &path_length) != napi_ok ||
        path_length == 0 || path_length > MAX_PATH_BYTES ||
        napi_get_value_string_utf8(environment, arguments[index], paths[index],
                                   sizeof(paths[index]), NULL) != napi_ok) {
      napi_throw_type_error(environment, NULL,
                            "Atomic exchange path is invalid");
      return NULL;
    }
  }

  struct stat current_second;
  if (fstatat(AT_FDCWD, paths[1], &current_second, AT_SYMLINK_NOFOLLOW) != 0) {
    napi_throw_error(environment, NULL, strerror(errno));
    return NULL;
  }
  if (!S_ISREG(current_second.st_mode) ||
      (uint64_t)current_second.st_dev != expected_device ||
      (uint64_t)current_second.st_ino != expected_inode) {
    napi_value rejected;
    napi_get_boolean(environment, false, &rejected);
    return rejected;
  }

#if defined(__linux__)
  const int result =
      renameat2(AT_FDCWD, paths[0], AT_FDCWD, paths[1], RENAME_EXCHANGE);
#elif defined(__APPLE__)
  const int result =
      renameatx_np(AT_FDCWD, paths[0], AT_FDCWD, paths[1], RENAME_SWAP);
#else
#error "Atomic path exchange is unsupported on this platform"
#endif

  if (result != 0) {
    napi_throw_error(environment, NULL, strerror(errno));
    return NULL;
  }

  napi_value exchanged;
  napi_get_boolean(environment, true, &exchanged);
  return exchanged;
}

NAPI_MODULE_INIT() {
  napi_value exchange;
  if (napi_create_function(env, "exchangePaths", NAPI_AUTO_LENGTH,
                           exchange_paths, NULL, &exchange) != napi_ok ||
      napi_set_named_property(env, exports, "exchangePaths", exchange) !=
          napi_ok) {
    napi_throw_error(env, NULL, "Atomic exchange module initialization failed");
    return NULL;
  }
  return exports;
}
