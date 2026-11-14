use solana_bn254::prelude::{
    alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be,
};

pub struct VerifyingKey {
    pub alpha_g1: [u8; 64],
    pub beta_g2: [u8; 128],
    pub gamma_g2: [u8; 128],
    pub delta_g2: [u8; 128],
    pub ic: &'static [[u8; 64]],
}

pub const SCALAR_FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub fn is_scalar(value: &[u8; 32]) -> bool {
    value < &SCALAR_FIELD_MODULUS
}

fn public_input_point(inputs: &[[u8; 32]], vk: &VerifyingKey) -> Option<[u8; 64]> {
    if vk.ic.len() != inputs.len() + 1 {
        return None;
    }
    let mut acc = vk.ic[0];
    for (input, ic) in inputs.iter().zip(&vk.ic[1..]) {
        if !is_scalar(input) {
            return None;
        }
        let mut product_input = [0u8; 96];
        product_input[..64].copy_from_slice(ic);
        product_input[64..].copy_from_slice(input);
        let product = alt_bn128_g1_multiplication_be(&product_input).ok()?;

        let mut sum_input = [0u8; 128];
        sum_input[..64].copy_from_slice(&acc);
        sum_input[64..].copy_from_slice(product.get(..64)?);
        let sum = alt_bn128_g1_addition_be(&sum_input).ok()?;
        acc.copy_from_slice(sum.get(..64)?);
    }
    Some(acc)
}

pub fn verify(
    negated_a: &[u8; 64],
    b: &[u8; 128],
    c: &[u8; 64],
    inputs: &[[u8; 32]],
    vk: &VerifyingKey,
) -> bool {
    let Some(vk_x) = public_input_point(inputs, vk) else {
        return false;
    };
    let mut pairs = [0u8; 4 * 192];
    pairs[0..64].copy_from_slice(negated_a);
    pairs[64..192].copy_from_slice(b);
    pairs[192..256].copy_from_slice(&vk.alpha_g1);
    pairs[256..384].copy_from_slice(&vk.beta_g2);
    pairs[384..448].copy_from_slice(&vk_x);
    pairs[448..576].copy_from_slice(&vk.gamma_g2);
    pairs[576..640].copy_from_slice(c);
    pairs[640..768].copy_from_slice(&vk.delta_g2);
    match alt_bn128_pairing_be(&pairs) {
        Ok(result) => {
            result.len() == 32 && result[31] == 1 && result[..31].iter().all(|byte| *byte == 0)
        }
        Err(_) => false,
    }
}
