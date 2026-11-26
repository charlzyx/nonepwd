#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "nonepwd_env")]
extern "C" {
    fn host_fill_random(ptr: *mut u8, len: usize);
}

pub fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    if buf.is_empty() {
        return Ok(());
    }
    #[cfg(target_arch = "wasm32")]
    {
        unsafe {
            host_fill_random(buf.as_mut_ptr(), buf.len());
        }
        Ok(())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        getrandom::getrandom(buf).map_err(|e| format!("CSPRNG error: {e}"))
    }
}

pub fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    fill_random(&mut buf)?;
    Ok(buf)
}

pub fn random_int(max_exclusive: usize) -> Result<usize, String> {
    if max_exclusive == 0 {
        return Err("max_exclusive must be > 0".to_string());
    }
    if max_exclusive == 1 {
        return Ok(0);
    }
    if max_exclusive <= (u32::MAX as usize) {
        let m = max_exclusive as u64;
        let total = u32::MAX as u64 + 1;
        let limit = total - (total % m);
        let mut raw = [0u8; 4];
        loop {
            fill_random(&mut raw)?;
            let val = u32::from_le_bytes(raw) as u64;
            if val < limit {
                return Ok((val % m) as usize);
            }
        }
    } else {
        let m = max_exclusive as u128;
        let total = (u64::MAX as u128) + 1;
        let limit = total - (total % m);
        let mut raw = [0u8; 8];
        loop {
            fill_random(&mut raw)?;
            let val = u64::from_le_bytes(raw) as u128;
            if val < limit {
                return Ok((val % m) as usize);
            }
        }
    }
}

pub fn random_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    fill_random(&mut b)?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3],
        b[4], b[5],
        b[6], b[7],
        b[8], b[9],
        b[10], b[11], b[12], b[13], b[14], b[15]
    ))
}
