#ifndef NONEPWD_CORE_H
#define NONEPWD_CORE_H

#include <stddef.h>
#include <stdint.h>

uint8_t *np_alloc(size_t len);
void np_dealloc(uint8_t *ptr, size_t len);
void np_free_result(uint8_t *ptr, size_t len);
uint8_t *np_invoke_native(const uint8_t *in_ptr, size_t in_len, size_t *out_len);

#endif
