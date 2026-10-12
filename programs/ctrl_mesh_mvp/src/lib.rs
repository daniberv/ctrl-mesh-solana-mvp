use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("F6eKaEwArFVNWphDWbzawQmnboAVr8XWwDHY8FkzJ2Qi");

const OPEN: u8 = 0;
const SUBMITTED: u8 = 1;
const ACCEPTED: u8 = 2;
const REFUNDED: u8 = 3;

#[program]
pub mod ctrl_mesh_mvp {
    use super::*;

    pub fn create_task(
        ctx: Context<CreateTask>, task_id: u64, worker: Pubkey, approver: Pubkey,
        amount: u64, deadline: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(deadline > Clock::get()?.unix_timestamp, EscrowError::InvalidDeadline);
        require!(worker != Pubkey::default(), EscrowError::InvalidWorker);
        require!(approver != Pubkey::default(), EscrowError::InvalidApprover);
        require!(worker != approver, EscrowError::SameWorkerAndApprover);
        let task = &mut ctx.accounts.task;
        task.id = task_id;
        task.owner = ctx.accounts.owner.key();
        task.worker = worker;
        task.approver = approver;
        task.amount = amount;
        task.deadline = deadline;
        task.state = OPEN;
        task.package_hash = [0; 32];
        task.bump = ctx.bumps.task;
        system_program::transfer(CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer { from: ctx.accounts.owner.to_account_info(), to: task.to_account_info() },
        ), amount)?;
        emit!(TaskOpened { task: task.key(), owner: task.owner, worker, approver, amount, deadline });
        Ok(())
    }

    pub fn submit_work(ctx: Context<SubmitWork>, package_hash: [u8; 32]) -> Result<()> {
        let task = &mut ctx.accounts.task;
        require!(task.state == OPEN, EscrowError::WrongState);
        require!(Clock::get()?.unix_timestamp <= task.deadline, EscrowError::DeadlinePassed);
        require!(package_hash != [0; 32], EscrowError::InvalidPackageHash);
        task.package_hash = package_hash;
        task.state = SUBMITTED;
        emit!(WorkSubmitted { task: task.key(), worker: task.worker, package_hash });
        Ok(())
    }

    pub fn accept_work(ctx: Context<AcceptWork>, package_hash: [u8; 32]) -> Result<()> {
        let task = &mut ctx.accounts.task;
        require!(task.state == SUBMITTED, EscrowError::WrongState);
        require!(Clock::get()?.unix_timestamp <= task.deadline, EscrowError::DeadlinePassed);
        require!(package_hash == task.package_hash, EscrowError::PackageHashMismatch);
        let task_info = task.to_account_info();
        let worker_info = ctx.accounts.worker.to_account_info();
        let rent = Rent::get()?.minimum_balance(8 + Task::INIT_SPACE);
        let remaining = task_info.lamports().checked_sub(task.amount).ok_or(EscrowError::InsufficientEscrow)?;
        require!(remaining >= rent, EscrowError::InsufficientEscrow);
        **task_info.try_borrow_mut_lamports()? -= task.amount;
        **worker_info.try_borrow_mut_lamports()? += task.amount;
        task.state = ACCEPTED;
        emit!(WorkAccepted { task: task.key(), worker: task.worker, package_hash, amount: task.amount });
        Ok(())
    }

    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let task = &mut ctx.accounts.task;
        require!(task.state == OPEN || task.state == SUBMITTED, EscrowError::WrongState);
        require!(Clock::get()?.unix_timestamp > task.deadline, EscrowError::DeadlineNotPassed);
        let task_info = task.to_account_info();
        let owner_info = ctx.accounts.owner.to_account_info();
        let rent = Rent::get()?.minimum_balance(8 + Task::INIT_SPACE);
        let remaining = task_info.lamports().checked_sub(task.amount).ok_or(EscrowError::InsufficientEscrow)?;
        require!(remaining >= rent, EscrowError::InsufficientEscrow);
        **task_info.try_borrow_mut_lamports()? -= task.amount;
        **owner_info.try_borrow_mut_lamports()? += task.amount;
        task.state = REFUNDED;
        emit!(TaskRefunded { task: task.key(), owner: task.owner, amount: task.amount });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CreateTask<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Task::INIT_SPACE,
        seeds = [b"task", owner.key().as_ref(), &task_id.to_le_bytes()], bump)]
    pub task: Account<'info, Task>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitWork<'info> {
    #[account(mut, has_one = worker)]
    pub task: Account<'info, Task>,
    pub worker: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptWork<'info> {
    #[account(mut, has_one = approver, has_one = worker)]
    pub task: Account<'info, Task>,
    pub approver: Signer<'info>,
    /// CHECK: The stored worker address is checked by has_one and only receives lamports.
    #[account(mut)]
    pub worker: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut, has_one = owner)]
    pub task: Account<'info, Task>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Task {
    pub id: u64,
    pub owner: Pubkey,
    pub worker: Pubkey,
    pub approver: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub state: u8,
    pub package_hash: [u8; 32],
    pub bump: u8,
}

#[event]
pub struct TaskOpened { pub task: Pubkey, pub owner: Pubkey, pub worker: Pubkey, pub approver: Pubkey, pub amount: u64, pub deadline: i64 }
#[event]
pub struct WorkSubmitted { pub task: Pubkey, pub worker: Pubkey, pub package_hash: [u8; 32] }
#[event]
pub struct WorkAccepted { pub task: Pubkey, pub worker: Pubkey, pub package_hash: [u8; 32], pub amount: u64 }
#[event]
pub struct TaskRefunded { pub task: Pubkey, pub owner: Pubkey, pub amount: u64 }

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be positive")] InvalidAmount,
    #[msg("Deadline must be in the future")] InvalidDeadline,
    #[msg("Worker key is invalid")] InvalidWorker,
    #[msg("Approver key is invalid")] InvalidApprover,
    #[msg("Worker and approver must be different keys")] SameWorkerAndApprover,
    #[msg("Task is in the wrong state")] WrongState,
    #[msg("Deadline has passed")] DeadlinePassed,
    #[msg("Deadline has not passed")] DeadlineNotPassed,
    #[msg("Package hash must be nonzero")] InvalidPackageHash,
    #[msg("Package hash does not match the submitted work")] PackageHashMismatch,
    #[msg("Escrow balance is insufficient")] InsufficientEscrow,
}
