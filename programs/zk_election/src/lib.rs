use anchor_lang::prelude::*;

pub mod merkle;
pub mod verifier;
pub mod vk_register;
pub mod vk_vote;
pub mod zeros;

use vk_register::{REGISTER_NR_INPUTS, VK_REGISTER};
use vk_vote::{VK_VOTE, VOTE_NR_INPUTS};

declare_id!("AwcbfwxYwfcxyr5WWpws9PwjeSnvNwYVH6PnsEdgE82o");

pub const TREE_DEPTH: usize = 20;
pub const MAX_OPTIONS: usize = 8;

pub mod vote_input {
    pub const ROOT: usize = 0;
    pub const VOTE_NULLIFIER: usize = 1;
    pub const VOTE: usize = 2;
    pub const ELECTION_ID: usize = 3;
}

pub mod register_input {
    pub const PASSPORT_NULLIFIER: usize = 0;
    pub const COMMITMENT: usize = 1;
    pub const ELECTION_ID: usize = 2;
    pub const CURRENT_DATE: usize = 3;
    pub const TRUSTED_KEY_ROOT: usize = 4;
}

#[program]
pub mod zk_election {
    use super::*;

    pub fn create_election(
        ctx: Context<CreateElection>,
        election_id: u64,
        option_count: u8,
        trusted_key_root: [u8; 32],
    ) -> Result<()> {
        require!(
            (2..=MAX_OPTIONS as u8).contains(&option_count),
            ElectionError::InvalidOption
        );
        let e = &mut ctx.accounts.election;
        e.authority = ctx.accounts.authority.key();
        e.election_id = election_id;
        e.phase = Phase::Registration;
        e.option_count = option_count;
        e.trusted_key_root = trusted_key_root;
        e.root = merkle::empty_root();
        e.next_index = 0;
        e.filled_subtrees = [[0u8; 32]; TREE_DEPTH];
        e.tally = [0u64; MAX_OPTIONS];
        e.bump = ctx.bumps.election;
        Ok(())
    }

    pub fn register(
        ctx: Context<Register>,
        proof: Groth16Proof,
        public_inputs: RegisterPublicInputs,
    ) -> Result<()> {
        let e = &mut ctx.accounts.election;
        let inputs: [[u8; 32]; REGISTER_NR_INPUTS] = public_inputs.to_array();

        require!(e.phase == Phase::Registration, ElectionError::WrongPhase);
        require!(
            inputs[register_input::ELECTION_ID] == u64_to_field(e.election_id),
            ElectionError::ElectionMismatch
        );
        require!(
            inputs[register_input::TRUSTED_KEY_ROOT] == e.trusted_key_root,
            ElectionError::KeyRootMismatch
        );
        let now = Clock::get()?.unix_timestamp;
        let date = inputs[register_input::CURRENT_DATE];
        require!(
            date == u64_to_field(yymmdd_from_unix(now) as u64)
                || date == u64_to_field(yymmdd_from_unix(now - SECONDS_PER_DAY) as u64),
            ElectionError::StaleDate
        );

        verify_groth16(&proof, &inputs, &VK_REGISTER)?;

        insert_commitment(e, inputs[register_input::COMMITMENT])
    }

    pub fn open_voting(ctx: Context<AuthorityOnly>) -> Result<()> {
        let e = &mut ctx.accounts.election;
        require!(e.phase == Phase::Registration, ElectionError::WrongPhase);
        e.phase = Phase::Voting;
        Ok(())
    }

    pub fn cast_vote(
        ctx: Context<CastVote>,
        proof: Groth16Proof,
        public_inputs: VotePublicInputs,
    ) -> Result<()> {
        let e = &mut ctx.accounts.election;
        let public_inputs: [[u8; 32]; VOTE_NR_INPUTS] = public_inputs.to_array();

        require!(e.phase == Phase::Voting, ElectionError::WrongPhase);
        require!(
            public_inputs[vote_input::ELECTION_ID] == u64_to_field(e.election_id),
            ElectionError::ElectionMismatch
        );
        require!(
            public_inputs[vote_input::ROOT] == e.root,
            ElectionError::RootMismatch
        );
        let option = field_to_option(&public_inputs[vote_input::VOTE])
            .filter(|o| *o < e.option_count)
            .ok_or(ElectionError::InvalidOption)?;

        verify_groth16(&proof, &public_inputs, &VK_VOTE)?;

        e.tally[option as usize] = e.tally[option as usize]
            .checked_add(1)
            .ok_or(ElectionError::TallyOverflow)?;

        emit!(VoteCast {
            election: e.key(),
            option,
            vote_nullifier: public_inputs[vote_input::VOTE_NULLIFIER],
            new_tally: e.tally,
        });
        Ok(())
    }

    pub fn close_election(ctx: Context<AuthorityOnly>) -> Result<()> {
        let e = &mut ctx.accounts.election;
        require!(e.phase == Phase::Voting, ElectionError::WrongPhase);
        e.phase = Phase::Closed;
        Ok(())
    }
}

fn insert_commitment(e: &mut Account<Election>, commitment: [u8; 32]) -> Result<()> {
    let leaf_index = e.next_index;
    let new_root = merkle::insert(&mut e.filled_subtrees, leaf_index, commitment)?;
    e.root = new_root;
    e.next_index = leaf_index.checked_add(1).ok_or(ElectionError::TreeFull)?;
    emit!(Registered {
        election: e.key(),
        commitment,
        leaf_index,
        new_root,
    });
    Ok(())
}

fn verify_groth16<const N: usize>(
    proof: &Groth16Proof,
    public_inputs: &[[u8; 32]; N],
    vk: &verifier::VerifyingKey,
) -> Result<()> {
    require!(
        verifier::verify(&proof.a, &proof.b, &proof.c, public_inputs, vk),
        ElectionError::InvalidProof
    );
    Ok(())
}

pub const SECONDS_PER_DAY: i64 = 86_400;

pub fn yymmdd_from_unix(timestamp: i64) -> u32 {
    let z = timestamp.div_euclid(SECONDS_PER_DAY) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year.rem_euclid(100) * 10_000 + month * 100 + day) as u32
}

pub fn u64_to_field(x: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

pub fn field_to_option(x: &[u8; 32]) -> Option<u8> {
    if x[..31].iter().all(|b| *b == 0) {
        Some(x[31])
    } else {
        None
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Registration,
    Voting,
    Closed,
}

#[account]
pub struct Election {
    pub authority: Pubkey,
    pub election_id: u64,
    pub phase: Phase,
    pub option_count: u8,
    pub trusted_key_root: [u8; 32],
    pub root: [u8; 32],
    pub next_index: u32,
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
    pub tally: [u64; MAX_OPTIONS],
    pub bump: u8,
}

impl Election {
    pub const SPACE: usize =
        8 + 32 + 8 + 1 + 1 + 32 + 32 + 4 + 32 * TREE_DEPTH + 8 * MAX_OPTIONS + 1;
}

#[account]
pub struct PassportNullifier {}

#[account]
pub struct VoteNullifier {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Groth16Proof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VotePublicInputs {
    pub root: [u8; 32],
    pub vote_nullifier: [u8; 32],
    pub vote: [u8; 32],
    pub election_id: [u8; 32],
}

impl VotePublicInputs {
    pub fn to_array(&self) -> [[u8; 32]; VOTE_NR_INPUTS] {
        let mut out = [[0u8; 32]; VOTE_NR_INPUTS];
        out[vote_input::ROOT] = self.root;
        out[vote_input::VOTE_NULLIFIER] = self.vote_nullifier;
        out[vote_input::VOTE] = self.vote;
        out[vote_input::ELECTION_ID] = self.election_id;
        out
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterPublicInputs {
    pub passport_nullifier: [u8; 32],
    pub commitment: [u8; 32],
    pub election_id: [u8; 32],
    pub current_date: [u8; 32],
    pub trusted_key_root: [u8; 32],
}

impl RegisterPublicInputs {
    pub fn to_array(&self) -> [[u8; 32]; REGISTER_NR_INPUTS] {
        let mut out = [[0u8; 32]; REGISTER_NR_INPUTS];
        out[register_input::PASSPORT_NULLIFIER] = self.passport_nullifier;
        out[register_input::COMMITMENT] = self.commitment;
        out[register_input::ELECTION_ID] = self.election_id;
        out[register_input::CURRENT_DATE] = self.current_date;
        out[register_input::TRUSTED_KEY_ROOT] = self.trusted_key_root;
        out
    }
}

#[derive(Accounts)]
#[instruction(election_id: u64)]
pub struct CreateElection<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Election::SPACE,
        seeds = [b"election", election_id.to_le_bytes().as_ref()],
        bump
    )]
    pub election: Box<Account<'info, Election>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ ElectionError::NotAuthority,
        seeds = [b"election", election.election_id.to_le_bytes().as_ref()],
        bump = election.bump
    )]
    pub election: Box<Account<'info, Election>>,
}

#[derive(Accounts)]
#[instruction(proof: Groth16Proof, public_inputs: RegisterPublicInputs)]
pub struct Register<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"election", election.election_id.to_le_bytes().as_ref()],
        bump = election.bump
    )]
    pub election: Box<Account<'info, Election>>,
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [b"pn", election.key().as_ref(), public_inputs.passport_nullifier.as_ref()],
        bump
    )]
    pub passport_nullifier: Account<'info, PassportNullifier>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Groth16Proof, public_inputs: VotePublicInputs)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"election", election.election_id.to_le_bytes().as_ref()],
        bump = election.bump
    )]
    pub election: Box<Account<'info, Election>>,
    #[account(
        init,
        payer = payer,
        space = 8,
        seeds = [b"vn", election.key().as_ref(), public_inputs.vote_nullifier.as_ref()],
        bump
    )]
    pub vote_nullifier: Account<'info, VoteNullifier>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Registered {
    pub election: Pubkey,
    pub commitment: [u8; 32],
    pub leaf_index: u32,
    pub new_root: [u8; 32],
}

#[event]
pub struct VoteCast {
    pub election: Pubkey,
    pub option: u8,
    pub vote_nullifier: [u8; 32],
    pub new_tally: [u64; MAX_OPTIONS],
}

#[error_code]
pub enum ElectionError {
    #[msg("The election is not in the right phase for this action")]
    WrongPhase,
    #[msg("The proof is for a different election")]
    ElectionMismatch,
    #[msg("The proof is for a different voter tree root")]
    RootMismatch,
    #[msg("The proof is for a different trusted-key root")]
    KeyRootMismatch,
    #[msg("The proof's date is not today or yesterday (UTC)")]
    StaleDate,
    #[msg("The option is out of range")]
    InvalidOption,
    #[msg("The zero-knowledge proof did not verify")]
    InvalidProof,
    #[msg("The voter tree is full")]
    TreeFull,
    #[msg("Signer is not the election authority")]
    NotAuthority,
    #[msg("Value is not a BN254 field element")]
    NotAFieldElement,
    #[msg("Tally overflow")]
    TallyOverflow,
}

#[cfg(test)]
mod date_tests {
    use super::yymmdd_from_unix;

    #[test]
    fn converts_unix_time_to_yymmdd_in_utc() {
        assert_eq!(yymmdd_from_unix(0), 700101);
        assert_eq!(yymmdd_from_unix(951_782_400), 229);
        assert_eq!(yymmdd_from_unix(1_709_164_800), 240229);
        assert_eq!(yymmdd_from_unix(1_735_689_599), 241231);
        assert_eq!(yymmdd_from_unix(1_735_689_600), 250101);
        assert_eq!(yymmdd_from_unix(1_794_528_000), 261113);
    }
}
