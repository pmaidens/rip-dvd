#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

enum { MAX_PATH_BYTES = 4096 };

static bool read_path(napi_env environment, napi_value value,
                      char path[MAX_PATH_BYTES + 1]) {
  napi_valuetype type;
  size_t path_length;
  return napi_typeof(environment, value, &type) == napi_ok &&
         type == napi_string &&
         napi_get_value_string_utf8(environment, value, NULL, 0,
                                    &path_length) == napi_ok &&
         path_length > 0 && path_length <= MAX_PATH_BYTES &&
         napi_get_value_string_utf8(environment, value, path,
                                    MAX_PATH_BYTES + 1, NULL) == napi_ok;
}

static napi_value exchange_paths(napi_env environment,
                                 napi_callback_info callback) {
  size_t argument_count = 2;
  napi_value arguments[2];
  if (napi_get_cb_info(environment, callback, &argument_count, arguments, NULL,
                       NULL) != napi_ok ||
      argument_count != 2) {
    napi_throw_type_error(environment, NULL,
                          "Atomic exchange requires two paths");
    return NULL;
  }

  char paths[2][MAX_PATH_BYTES + 1];
  for (size_t index = 0; index < 2; index += 1) {
    if (!read_path(environment, arguments[index], paths[index])) {
      napi_throw_type_error(environment, NULL,
                            "Atomic exchange path is invalid");
      return NULL;
    }
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

  napi_value undefined;
  napi_get_undefined(environment, &undefined);
  return undefined;
}

static napi_value try_acquire_lock(napi_env environment,
                                   napi_callback_info callback) {
  size_t argument_count = 1;
  napi_value argument;
  if (napi_get_cb_info(environment, callback, &argument_count, &argument, NULL,
                       NULL) != napi_ok ||
      argument_count != 1) {
    napi_throw_type_error(environment, NULL,
                          "Publication mutation lock requires one path");
    return NULL;
  }
  char path[MAX_PATH_BYTES + 1];
  if (!read_path(environment, argument, path)) {
    napi_throw_type_error(environment, NULL,
                          "Publication mutation lock path is invalid");
    return NULL;
  }
  const int descriptor =
      open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    napi_throw_error(environment, NULL, strerror(errno));
    return NULL;
  }
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    const int lock_error = errno;
    close(descriptor);
    if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
      napi_value unavailable;
      napi_get_null(environment, &unavailable);
      return unavailable;
    }
    napi_throw_error(environment, NULL, strerror(lock_error));
    return NULL;
  }
  napi_value handle;
  napi_create_int32(environment, descriptor, &handle);
  return handle;
}

static napi_value release_lock(napi_env environment,
                               napi_callback_info callback) {
  size_t argument_count = 1;
  napi_value argument;
  int32_t descriptor;
  if (napi_get_cb_info(environment, callback, &argument_count, &argument, NULL,
                       NULL) != napi_ok ||
      argument_count != 1 ||
      napi_get_value_int32(environment, argument, &descriptor) != napi_ok ||
      descriptor < 0) {
    napi_throw_type_error(environment, NULL,
                          "Publication mutation lock handle is invalid");
    return NULL;
  }
  if (close(descriptor) != 0) {
    napi_throw_error(environment, NULL, strerror(errno));
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(environment, &undefined);
  return undefined;
}

NAPI_MODULE_INIT() {
  napi_value exchange;
  napi_value acquire;
  napi_value release;
  if (napi_create_function(env, "exchangePaths", NAPI_AUTO_LENGTH,
                           exchange_paths, NULL, &exchange) != napi_ok ||
      napi_create_function(env, "tryAcquireLock", NAPI_AUTO_LENGTH,
                           try_acquire_lock, NULL, &acquire) != napi_ok ||
      napi_create_function(env, "releaseLock", NAPI_AUTO_LENGTH, release_lock,
                           NULL, &release) != napi_ok ||
      napi_set_named_property(env, exports, "exchangePaths", exchange) !=
          napi_ok ||
      napi_set_named_property(env, exports, "tryAcquireLock", acquire) !=
          napi_ok ||
      napi_set_named_property(env, exports, "releaseLock", release) !=
          napi_ok) {
    napi_throw_error(env, NULL, "Atomic exchange module initialization failed");
    return NULL;
  }
  return exports;
}
