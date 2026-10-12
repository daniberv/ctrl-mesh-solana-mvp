use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program::{self, Transfer};

pub const MAX_MEMBERS: usize = 8;

pub fn project_create(
    ctx: Context<ProjectCreate>,
    id: u64,
    manager: Pubkey,
    reviewer: Pubkey,
    allowance: u64,
    expires: i64,
    amount: u64,
    event: [u8; 32],
) -> Result<()> {
    require!(
        manager != Pubkey::default() && reviewer != Pubkey::default() && manager != reviewer,
        MeshError::Invalid
    );
    require!(
        expires > Clock::get()?.unix_timestamp && allowance <= amount,
        MeshError::Budget
    );
    let p = &mut ctx.accounts.project;
    p.id = id;
    p.owner = ctx.accounts.owner.key();
    p.manager = manager;
    p.reviewer = reviewer;
    p.allowance = allowance;
    p.expires = expires;
    p.committed = 0;
    p.revision = 0;
    p.closed = false;
    p.open_jobs = 0;
    p.last_event = event;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: p.to_account_info(),
            },
        ),
        amount,
    )?;
    Ok(())
}

pub fn project_policy(
    ctx: Context<ProjectPolicy>,
    manager: Pubkey,
    reviewer: Pubkey,
    allowance: u64,
    expires: i64,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &mut ctx.accounts.project;
    require!(p.revision == revision, MeshError::Conflict);
    require!(
        allowance >= p.committed
            && manager != Pubkey::default()
            && reviewer != Pubkey::default()
            && manager != reviewer,
        MeshError::Budget
    );
    p.manager = manager;
    p.reviewer = reviewer;
    p.allowance = allowance;
    p.expires = expires;
    p.revision += 1;
    p.last_event = event;
    Ok(())
}

pub fn job_open(
    ctx: Context<JobOpen>,
    id: u64,
    budget: u64,
    deadline: i64,
    dependencies: Vec<Pubkey>,
    event: [u8; 32],
) -> Result<()> {
    let p = &mut ctx.accounts.project;
    authorize_manager(p, ctx.accounts.actor.key())?;
    require!(
        dependencies.len() <= 8 && budget > 0 && deadline > Clock::get()?.unix_timestamp,
        MeshError::Invalid
    );
    require!(
        p.committed.checked_add(budget).ok_or(MeshError::Budget)? <= p.allowance
            || ctx.accounts.actor.key() == p.owner,
        MeshError::Budget
    );
    let j = &mut ctx.accounts.job;
    j.id = id;
    j.project = p.key();
    j.budget = budget;
    j.deadline = deadline;
    j.revision = 0;
    j.state = 0;
    j.dependencies = dependencies;
    j.last_event = event;
    move_lamports(
        &p.to_account_info(),
        &j.to_account_info(),
        budget,
        8 + Project::INIT_SPACE,
    )?;
    p.committed = p.committed.checked_add(budget).ok_or(MeshError::Budget)?;
    p.open_jobs = p.open_jobs.checked_add(1).ok_or(MeshError::State)?;
    emit!(MeshTransition {
        project: p.key(),
        job: j.key(),
        revision: 0,
        state: 0,
        event
    });
    Ok(())
}

pub fn job_award(
    ctx: Context<JobManage>,
    worker: Pubkey,
    recipient: Pubkey,
    amount: u64,
    lease_until: i64,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &ctx.accounts.project;
    authorize_manager(p, ctx.accounts.actor.key())?;
    let j = &mut ctx.accounts.job;
    check_job(j, revision)?;
    require!(
        j.state <= 1 && j.members.len() < MAX_MEMBERS,
        MeshError::State
    );
    require!(
        worker != p.reviewer && worker != Pubkey::default() && recipient != Pubkey::default(),
        MeshError::Role
    );
    require!(
        !j.members.iter().any(|m| m.worker == worker),
        MeshError::Role
    );
    let total = j
        .members
        .iter()
        .try_fold(0u64, |sum, m| sum.checked_add(m.amount))
        .ok_or(MeshError::Budget)?;
    require!(
        amount > 0 && total.checked_add(amount).ok_or(MeshError::Budget)? <= j.budget,
        MeshError::Budget
    );
    require!(
        lease_until > Clock::get()?.unix_timestamp && lease_until <= j.deadline,
        MeshError::Invalid
    );
    j.members.push(Contributor {
        worker,
        recipient,
        amount,
        lease_until,
        hash: [0; 32],
        paid: false,
    });
    j.state = 1;
    bump(j, event);
    Ok(())
}

pub fn job_submit(
    ctx: Context<JobManage>,
    hash: [u8; 32],
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let j = &mut ctx.accounts.job;
    check_job(j, revision)?;
    require!(
        j.state == 1 || j.state == 2 || j.state == 3,
        MeshError::State
    );
    check_dependencies(j, ctx.remaining_accounts)?;
    let m = j
        .members
        .iter_mut()
        .find(|m| m.worker == ctx.accounts.actor.key())
        .ok_or(MeshError::Role)?;
    require!(
        m.lease_until >= Clock::get()?.unix_timestamp,
        MeshError::Lease
    );
    require!(hash != [0; 32], MeshError::Invalid);
    m.hash = hash;
    let mut bytes = Vec::new();
    for member in &j.members {
        bytes.extend_from_slice(member.worker.as_ref());
        bytes.extend_from_slice(&member.hash);
    }
    j.result_root = hashv(&[&bytes]).to_bytes();
    j.review_root = [0; 32];
    j.state = if j.members.iter().all(|m| m.hash != [0; 32]) {
        2
    } else {
        1
    };
    bump(j, event);
    Ok(())
}

pub fn job_review(
    ctx: Context<JobManage>,
    root: [u8; 32],
    approved: bool,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &ctx.accounts.project;
    let j = &mut ctx.accounts.job;
    check_job(j, revision)?;
    require!(
        ctx.accounts.actor.key() == p.reviewer && !j.members.iter().any(|m| m.worker == p.reviewer),
        MeshError::Role
    );
    require!(j.state == 2 && j.result_root == root, MeshError::State);
    j.review_root = if approved { root } else { [0; 32] };
    if !approved {
        j.state = 3;
    }
    bump(j, event);
    Ok(())
}

pub fn job_accept(
    ctx: Context<JobManage>,
    root: [u8; 32],
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &ctx.accounts.project;
    authorize_manager(p, ctx.accounts.actor.key())?;
    let j = &mut ctx.accounts.job;
    check_job(j, revision)?;
    require!(
        j.state == 2 && j.result_root == root && j.review_root == root && root != [0; 32],
        MeshError::State
    );
    check_dependencies(j, ctx.remaining_accounts)?;
    j.state = 4;
    bump(j, event);
    Ok(())
}

pub fn job_claim(ctx: Context<JobClaim>, revision: u64, event: [u8; 32]) -> Result<()> {
    let p = &mut ctx.accounts.project;
    let j = &mut ctx.accounts.job;
    require!(j.revision == revision && j.state == 4, MeshError::State);
    let m = j
        .members
        .iter()
        .find(|m| m.worker == ctx.accounts.actor.key())
        .ok_or(MeshError::Role)?;
    require!(
        !m.paid && m.recipient == ctx.accounts.recipient.key(),
        MeshError::Role
    );
    let amount = m.amount;
    move_lamports(
        &j.to_account_info(),
        &ctx.accounts.recipient.to_account_info(),
        amount,
        8 + Job::INIT_SPACE,
    )?;
    j.members
        .iter_mut()
        .find(|m| m.worker == ctx.accounts.actor.key())
        .unwrap()
        .paid = true;
    if j.members.iter().all(|m| m.paid) {
        p.open_jobs = p.open_jobs.checked_sub(1).ok_or(MeshError::State)?;
    }
    bump(j, event);
    Ok(())
}

pub fn job_cancel(ctx: Context<JobCancel>, revision: u64, event: [u8; 32]) -> Result<()> {
    let p = &mut ctx.accounts.project;
    let j = &mut ctx.accounts.job;
    require!(
        ctx.accounts.actor.key() == p.owner && j.revision == revision && j.state < 4,
        MeshError::Role
    );
    require!(
        Clock::get()?.unix_timestamp > j.deadline || j.members.is_empty(),
        MeshError::Lease
    );
    move_lamports(
        &j.to_account_info(),
        &p.to_account_info(),
        j.budget,
        8 + Job::INIT_SPACE,
    )?;
    j.state = 5;
    p.open_jobs = p.open_jobs.checked_sub(1).ok_or(MeshError::State)?;
    bump(j, event);
    Ok(())
}

pub fn job_release(
    ctx: Context<JobManage>,
    worker: Pubkey,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &ctx.accounts.project;
    let j = &mut ctx.accounts.job;
    check_job(j, revision)?;
    let m = j
        .members
        .iter()
        .find(|m| m.worker == worker)
        .ok_or(MeshError::Role)?;
    require!(m.hash == [0; 32] && j.state < 4, MeshError::State);
    if ctx.accounts.actor.key() != worker {
        authorize_manager(p, ctx.accounts.actor.key())?;
        require!(
            m.lease_until < Clock::get()?.unix_timestamp,
            MeshError::Lease
        );
    }
    j.members.retain(|m| m.worker != worker);
    j.state = if j.members.is_empty() { 0 } else { 1 };
    j.review_root = [0; 32];
    bump(j, event);
    Ok(())
}

pub fn job_renew(
    ctx: Context<JobManage>,
    lease_until: i64,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let j = &mut ctx.accounts.job;
    check_job(j, revision)?;
    require!(j.state < 4, MeshError::State);
    let deadline = j.deadline;
    let m = j
        .members
        .iter_mut()
        .find(|m| m.worker == ctx.accounts.actor.key())
        .ok_or(MeshError::Role)?;
    let now = Clock::get()?.unix_timestamp;
    require!(
        m.lease_until >= now
            && lease_until > m.lease_until
            && lease_until <= deadline
            && lease_until <= now + 3600,
        MeshError::Lease
    );
    m.lease_until = lease_until;
    bump(j, event);
    Ok(())
}

fn authorize_manager(p: &Project, actor: Pubkey) -> Result<()> {
    require!(!p.closed, MeshError::State);
    require!(
        actor == p.owner || (actor == p.manager && Clock::get()?.unix_timestamp <= p.expires),
        MeshError::Role
    );
    Ok(())
}
fn check_job(j: &Job, revision: u64) -> Result<()> {
    require!(j.revision == revision, MeshError::Conflict);
    require!(Clock::get()?.unix_timestamp <= j.deadline, MeshError::Lease);
    Ok(())
}
fn bump(j: &mut Account<Job>, event: [u8; 32]) {
    j.revision += 1;
    j.last_event = event;
    emit!(MeshTransition {
        project: j.project,
        job: j.key(),
        revision: j.revision,
        state: j.state,
        event
    });
}
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64, size: usize) -> Result<()> {
    let remaining = from
        .lamports()
        .checked_sub(amount)
        .ok_or(MeshError::Budget)?;
    require!(
        remaining >= Rent::get()?.minimum_balance(size),
        MeshError::Budget
    );
    **from.try_borrow_mut_lamports()? -= amount;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}
fn check_dependencies(j: &Job, accounts: &[AccountInfo]) -> Result<()> {
    require!(
        accounts.len() == j.dependencies.len(),
        MeshError::Dependency
    );
    for (key, info) in j.dependencies.iter().zip(accounts) {
        require!(
            info.key == key && info.owner == &crate::ID,
            MeshError::Dependency
        );
        let data = info.try_borrow_data()?;
        let dependency = Job::try_deserialize(&mut &data[..])?;
        require!(
            dependency.project == j.project && dependency.state == 4,
            MeshError::Dependency
        );
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(id:u64)]
pub struct ProjectCreate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init,payer=owner,space=8+Project::INIT_SPACE,seeds=[b"project",owner.key().as_ref(),&id.to_le_bytes()],bump)]
    pub project: Account<'info, Project>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ProjectPolicy<'info> {
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner)]
    pub project: Account<'info, Project>,
}
#[derive(Accounts)]
#[instruction(id:u64)]
pub struct JobOpen<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub actor: Signer<'info>,
    #[account(mut)]
    pub project: Account<'info, Project>,
    #[account(init,payer=payer,space=8+Job::INIT_SPACE,seeds=[b"job",project.key().as_ref(),&id.to_le_bytes()],bump)]
    pub job: Account<'info, Job>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct JobManage<'info> {
    pub actor: Signer<'info>,
    pub project: Account<'info, Project>,
    #[account(mut,has_one=project)]
    pub job: Account<'info, Job>,
}
#[derive(Accounts)]
pub struct JobCancel<'info> {
    pub actor: Signer<'info>,
    #[account(mut)]
    pub project: Account<'info, Project>,
    #[account(mut,has_one=project)]
    pub job: Account<'info, Job>,
}
#[derive(Accounts)]
pub struct ProjectCheckpoint<'info> {
    pub actor: Signer<'info>,
    #[account(mut)]
    pub project: Account<'info, Project>,
}
pub fn project_checkpoint(
    ctx: Context<ProjectCheckpoint>,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &mut ctx.accounts.project;
    authorize_manager(p, ctx.accounts.actor.key())?;
    require!(p.revision == revision, MeshError::Conflict);
    require!(p.open_jobs == 0, MeshError::State);
    p.closed = true;
    p.revision += 1;
    p.last_event = event;
    Ok(())
}
#[derive(Accounts)]
pub struct JobClaim<'info> {
    pub actor: Signer<'info>,
    #[account(mut)]
    pub project: Account<'info, Project>,
    #[account(mut,has_one=project)]
    pub job: Account<'info, Job>,
    /// CHECK: Must equal the immutable award recipient.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}
#[account]
#[derive(InitSpace)]
pub struct Project {
    pub id: u64,
    pub owner: Pubkey,
    pub manager: Pubkey,
    pub reviewer: Pubkey,
    pub allowance: u64,
    pub committed: u64,
    pub expires: i64,
    pub revision: u64,
    pub last_event: [u8; 32],
    pub closed: bool,
    pub open_jobs: u32,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Contributor {
    pub worker: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub lease_until: i64,
    pub hash: [u8; 32],
    pub paid: bool,
}
#[account]
#[derive(InitSpace)]
pub struct Job {
    pub id: u64,
    pub project: Pubkey,
    pub budget: u64,
    pub deadline: i64,
    pub revision: u64,
    pub state: u8,
    #[max_len(8)]
    pub dependencies: Vec<Pubkey>,
    #[max_len(8)]
    pub members: Vec<Contributor>,
    pub result_root: [u8; 32],
    pub review_root: [u8; 32],
    pub last_event: [u8; 32],
}
#[event]
pub struct MeshTransition {
    pub project: Pubkey,
    pub job: Pubkey,
    pub revision: u64,
    pub state: u8,
    pub event: [u8; 32],
}
#[error_code]
pub enum MeshError {
    #[msg("Invalid input")]
    Invalid,
    #[msg("Delegated budget exceeded or vault insufficient")]
    Budget,
    #[msg("Role does not authorize this action")]
    Role,
    #[msg("Stale revision; refresh context")]
    Conflict,
    #[msg("Transition or artifact version is invalid")]
    State,
    #[msg("Lease or deadline violation")]
    Lease,
    #[msg("Dependency is not accepted")]
    Dependency,
}

#[derive(Accounts)]
pub struct ProjectWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner)]
    pub project: Account<'info, Project>,
}
pub fn project_withdraw(
    ctx: Context<ProjectWithdraw>,
    amount: u64,
    revision: u64,
    event: [u8; 32],
) -> Result<()> {
    let p = &mut ctx.accounts.project;
    require!(p.revision == revision && amount > 0, MeshError::Conflict);
    move_lamports(
        &p.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        amount,
        8 + Project::INIT_SPACE,
    )?;
    p.revision += 1;
    p.last_event = event;
    Ok(())
}
pub fn job_reclaim(ctx: Context<JobCancel>, revision: u64, event: [u8; 32]) -> Result<()> {
    let p = &ctx.accounts.project;
    let j = &mut ctx.accounts.job;
    require!(
        ctx.accounts.actor.key() == p.owner
            && j.revision == revision
            && j.state == 4
            && j.members.iter().all(|m| m.paid),
        MeshError::Role
    );
    let allocated = j
        .members
        .iter()
        .try_fold(0u64, |sum, m| sum.checked_add(m.amount))
        .ok_or(MeshError::Budget)?;
    let remainder = j.budget.checked_sub(allocated).ok_or(MeshError::Budget)?;
    require!(remainder > 0, MeshError::Budget);
    move_lamports(
        &j.to_account_info(),
        &p.to_account_info(),
        remainder,
        8 + Job::INIT_SPACE,
    )?;
    j.budget = allocated;
    bump(j, event);
    Ok(())
}
