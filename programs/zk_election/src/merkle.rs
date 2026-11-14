use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters};

use crate::{zeros::ZEROS, ElectionError, TREE_DEPTH};

pub fn hash2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right])
        .map(|h| h.to_bytes())
        .map_err(|_| error!(ElectionError::NotAFieldElement))
}

pub const fn empty_root() -> [u8; 32] {
    ZEROS[TREE_DEPTH]
}

pub fn insert(
    filled_subtrees: &mut [[u8; 32]; TREE_DEPTH],
    next_index: u32,
    leaf: [u8; 32],
) -> Result<[u8; 32]> {
    require!(
        (next_index as u64) < (1u64 << TREE_DEPTH),
        ElectionError::TreeFull
    );
    let mut cur = leaf;
    let mut idx = next_index;
    for level in 0..TREE_DEPTH {
        if idx & 1 == 0 {
            filled_subtrees[level] = cur;
            cur = hash2(&cur, &ZEROS[level])?;
        } else {
            cur = hash2(&filled_subtrees[level], &cur)?;
        }
        idx >>= 1;
    }
    Ok(cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    fn hex_array(json: &str, key: &str) -> Vec<[u8; 32]> {
        let start = json.find(&format!("\"{key}\"")).expect("key");
        let open = start + json[start..].find('[').unwrap();
        let close = open + json[open..].find(']').unwrap();
        json[open..close]
            .split('"')
            .filter(|s| s.len() == 64)
            .map(unhex)
            .collect()
    }

    fn number(json: &str, key: &str) -> usize {
        let start = json.find(&format!("\"{key}\"")).expect("key");
        let rest = &json[start + key.len() + 2..];
        let digits: String = rest
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().unwrap()
    }

    const MERKLE: &str = include_str!("../../../test-vectors/merkle.json");
    const CONSTANTS: &str = include_str!("../../../constants.json");

    #[test]
    fn constants_match_shared_file() {
        assert_eq!(number(CONSTANTS, "TREE_DEPTH"), TREE_DEPTH);
        assert_eq!(number(CONSTANTS, "MAX_OPTIONS"), crate::MAX_OPTIONS);
        assert_eq!(number(MERKLE, "depth"), TREE_DEPTH);
    }

    #[test]
    fn zeros_table_matches_poseidon_and_vectors() {
        assert_eq!(ZEROS[0], [0u8; 32]);
        for i in 0..TREE_DEPTH {
            assert_eq!(hash2(&ZEROS[i], &ZEROS[i]).unwrap(), ZEROS[i + 1]);
        }
        assert_eq!(hex_array(MERKLE, "zeros"), ZEROS.to_vec());
    }

    #[test]
    fn roots_match_cross_language_vectors() {
        let leaves = hex_array(MERKLE, "leaves");
        let roots = hex_array(MERKLE, "rootsAfterInsert");
        assert_eq!(leaves.len(), roots.len());
        let mut filled = [[0u8; 32]; TREE_DEPTH];
        for (i, leaf) in leaves.iter().enumerate() {
            let root = insert(&mut filled, i as u32, *leaf).unwrap();
            assert_eq!(root, roots[i], "root after inserting leaf {i}");
        }
    }
}
