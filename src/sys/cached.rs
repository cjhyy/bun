//! Answers about a path from what the kernel holds in memory, for a thread that must not wait
//! for a disk or a server: the JS thread, in front of a thread-pool job. Linux 5.12.
//!
//! `openat2(RESOLVE_CACHED)` bounds the walk of the path and nothing after it. `statx` of the
//! file it opened asks an NFS server once the attribute cache has expired, and 9p asks its
//! server whatever the flags say (`v9fs_vfs_getattr_dotl`). So the kernel is only asked about
//! a path on a mount that is known to answer from memory: the walk starts at a directory on
//! that mount and does not leave it (`RESOLVE_NO_XDEV`). Two directories serve, the root for an
//! absolute path and the working directory for a relative one. [`learn_mounts`] classifies
//! their mounts on a thread that may wait.

use core::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering};

use bun_core::ZStr;

use crate::linux_syscall::{self, ResolveFlags};
use crate::{CloseOnDrop, Fd, O, PosixStat};

/// Whether the last component of the path is followed if it is a symlink.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Symlink {
    Follow,
    NoFollow,
}

pub enum Lookup {
    Found(Found),
    /// The kernel remembers that the path has no entry.
    NotFound,
    /// The kernel was asked: only a lookup that may wait can tell. The path is not in its
    /// caches, or it leaves the mount, or a filesystem has to read a symlink on the way.
    Unknown,
    /// The kernel was not asked: the walk would not start on a mount that answers from memory.
    NotAsked,
}

/// A file on a mount that answers from memory. The descriptor is `O_PATH`: the filesystem was
/// not asked to open anything.
pub struct Found {
    file: CloseOnDrop,
    mount: u32,
    start: &'static Start,
}

impl Found {
    /// `None` if the file is not on the mount that the walk was to stay on: the root or the
    /// working directory changed behind this module (`chroot`, `chdir` by a native library).
    pub fn stat(&self, mask: u32) -> Option<PosixStat> {
        let (stat, mount) = crate::fstatx_in_memory(self.file.fd(), mask)?;
        if mount != u64::from(self.mount) {
            self.start.forget();
            return None;
        }
        Some(stat)
    }
}

const UNCHECKED: u8 = 0;
const AVAILABLE: u8 = 1;
const UNAVAILABLE: u8 = 2;
/// Whether the kernel takes `RESOLVE_CACHED`: [`learn_mounts`] finds out.
static AVAILABILITY: AtomicU8 = AtomicU8::new(UNCHECKED);

/// Whether [`lookup`] can answer. Not before [`learn_mounts`] has run once, not where the
/// kernel or a seccomp policy refuses `openat2(RESOLVE_CACHED)`, and not under
/// `BUN_FEATURE_FLAG_DISABLE_ASYNC_FS_FAST_PATH`.
#[inline]
pub fn is_available() -> bool {
    AVAILABILITY.load(Ordering::Relaxed) == AVAILABLE
}

fn open(path: &ZStr, symlink: Symlink, resolve: ResolveFlags) -> Result<Fd, i32> {
    let nofollow = match symlink {
        Symlink::Follow => 0,
        Symlink::NoFollow => O::NOFOLLOW,
    };
    linux_syscall::openat2(Fd::cwd(), path, O::PATH | O::CLOEXEC | nofollow, 0, resolve)
}

/// Does not wait. Only call it where [`is_available`].
pub fn lookup(path: &ZStr, symlink: Symlink) -> Lookup {
    let (start, generation) = match path.as_bytes().first() {
        Some(b'/') => (&ROOT, 0),
        _ => (&CWD, CWD_GENERATION.load(Ordering::SeqCst)),
    };
    let Some(mount) = start.in_memory_mount(generation) else {
        return Lookup::NotAsked;
    };
    match open(path, symlink, ResolveFlags::CACHED | ResolveFlags::NO_XDEV) {
        Ok(fd) => Lookup::Found(Found {
            file: CloseOnDrop::new(fd),
            mount,
            start,
        }),
        Err(libc::ENOENT) => Lookup::NotFound,
        Err(_) => Lookup::Unknown,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mount {
    Unknown,
    /// The mount with this id answers `statx` from memory.
    InMemory(u32),
    Other,
}

/// What is known of the mount of a directory that walks start at, in one word:
/// bits 0-1 the kind of [`Mount`], bits 2-33 the mount id, bits 34-63 the generation.
struct Start(AtomicU64);

const GENERATION_BITS: u32 = 30;

impl Start {
    fn load(&self, generation: u32) -> Mount {
        let word = self.0.load(Ordering::SeqCst);
        if word >> 34 != u64::from(generation & ((1 << GENERATION_BITS) - 1)) {
            return Mount::Unknown;
        }
        match word & 0b11 {
            1 => Mount::InMemory((word >> 2) as u32),
            2 => Mount::Other,
            _ => Mount::Unknown,
        }
    }

    fn in_memory_mount(&self, generation: u32) -> Option<u32> {
        match self.load(generation) {
            Mount::InMemory(mount) => Some(mount),
            Mount::Unknown | Mount::Other => None,
        }
    }

    fn store(&self, generation: u32, mount: Mount) {
        let (kind, id) = match mount {
            Mount::Unknown => (0, 0),
            Mount::InMemory(id) => (1, id),
            Mount::Other => (2, 0),
        };
        let generation = u64::from(generation & ((1 << GENERATION_BITS) - 1));
        self.0.store(
            generation << 34 | u64::from(id) << 2 | kind,
            Ordering::SeqCst,
        );
    }

    fn forget(&self) {
        self.0.store(0, Ordering::SeqCst);
    }
}

static ROOT: Start = Start(AtomicU64::new(0));
static CWD: Start = Start(AtomicU64::new(0));
/// Counts the changes of the working directory: what [`CWD`] learned before one is void.
static CWD_GENERATION: AtomicU32 = AtomicU32::new(0);

/// After `chdir` has succeeded.
pub(crate) fn working_directory_changed() {
    CWD_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Classifies the mounts of the root and of the working directory, if that is still to do.
/// It asks the filesystem, which may wait for a server: not for the JS thread.
pub fn learn_mounts() {
    match AVAILABILITY.load(Ordering::Relaxed) {
        AVAILABLE => {}
        UNAVAILABLE => return,
        _ => {
            use bun_core::env_var::feature_flag::BUN_FEATURE_FLAG_DISABLE_ASYNC_FS_FAST_PATH as DISABLED;
            if DISABLED.get().unwrap_or(false) {
                return AVAILABILITY.store(UNAVAILABLE, Ordering::Relaxed);
            }
            // Every kernel that knows the flag finds the root directory with it. The call
            // fails without `openat2` (before Linux 5.6, Android, seccomp) and without
            // `RESOLVE_CACHED` (before 5.12).
            match open(bun_core::zstr!("/"), Symlink::Follow, ResolveFlags::CACHED) {
                Ok(fd) => drop(CloseOnDrop::new(fd)),
                // A mount or unmount somewhere interrupted the walk: the next job asks again.
                Err(libc::EAGAIN) => return,
                Err(_) => return AVAILABILITY.store(UNAVAILABLE, Ordering::Relaxed),
            }
            AVAILABILITY.store(AVAILABLE, Ordering::Relaxed);
        }
    }
    if ROOT.load(0) == Mount::Unknown {
        ROOT.store(0, classify(bun_core::zstr!("/")));
    }
    let generation = CWD_GENERATION.load(Ordering::SeqCst);
    if CWD.load(generation) == Mount::Unknown {
        CWD.store(generation, classify(bun_core::zstr!(".")));
    }
}

fn classify(directory: &ZStr) -> Mount {
    let Ok(fd) = crate::open(directory, O::PATH | O::DIRECTORY | O::CLOEXEC, 0) else {
        return Mount::Other;
    };
    let directory = CloseOnDrop::new(fd);
    let mut fs = core::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: a live descriptor and a valid out-param.
    if unsafe { libc::fstatfs(directory.fd().native(), fs.as_mut_ptr()) } != 0 {
        return Mount::Other;
    }
    // SAFETY: `fstatfs` returned 0, so it filled the buffer.
    let fs = unsafe { fs.assume_init() };
    if !answers_statx_from_memory(fs.f_type as u64) {
        return Mount::Other;
    }
    match crate::fstatx_in_memory(directory.fd(), 0) {
        Some((_, mount)) => u32::try_from(mount).map_or(Mount::Other, Mount::InMemory),
        None => Mount::Other,
    }
}

/// The filesystems whose `getattr` reads the inode in memory and nothing else, by the magic
/// number of `statfs`. Not the network and cluster filesystems, not FUSE, and not one this list
/// has never heard of. overlayfs asks the filesystem of its layers, which is one of the others
/// in every container runtime.
fn answers_statx_from_memory(magic: u64) -> bool {
    const EXT4: u64 = 0xEF53;
    const XFS: u64 = 0x5846_5342;
    const BTRFS: u64 = 0x9123_683E;
    const F2FS: u64 = 0xF2F5_2010;
    const TMPFS: u64 = 0x0102_1994;
    const OVERLAYFS: u64 = 0x794C_7630;
    matches!(magic, EXT4 | XFS | BTRFS | F2FS | TMPFS | OVERLAYFS)
}

/// Whether `access(2)` decides as a lookup does. `access` asks for the real user and group and
/// for the capabilities they would have (`access_override_creds`); a lookup is made with the
/// filesystem user and group and the effective capabilities.
pub fn access_decides_like_lookup() -> bool {
    #[repr(C)]
    struct CapabilityHeader {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CapabilityData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    // <linux/capability.h>
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    const CAP_DAC_OVERRIDE: u32 = 1;
    const CAP_DAC_READ_SEARCH: u32 = 2;
    const SEARCH: u32 = 1 << CAP_DAC_OVERRIDE | 1 << CAP_DAC_READ_SEARCH;

    // Real, effective, saved.
    let mut users = [0 as libc::uid_t; 3];
    let mut groups = [0 as libc::gid_t; 3];
    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut capabilities = [CapabilityData::default(); 2];
    // SAFETY: each call writes the out-params it is given, which are live and of the size the
    // kernel expects. `setfsuid(-1)` and `setfsgid(-1)` change nothing and return the current id.
    let (fs_user, fs_group) = unsafe {
        let ids = users.as_mut_ptr();
        if libc::syscall(libc::SYS_getresuid, ids, ids.add(1), ids.add(2)) != 0 {
            return false;
        }
        let ids = groups.as_mut_ptr();
        if libc::syscall(libc::SYS_getresgid, ids, ids.add(1), ids.add(2)) != 0 {
            return false;
        }
        if libc::syscall(libc::SYS_capget, &raw mut header, capabilities.as_mut_ptr()) != 0 {
            return false;
        }
        (
            libc::syscall(libc::SYS_setfsuid, -1) as libc::uid_t,
            libc::syscall(libc::SYS_setfsgid, -1) as libc::gid_t,
        )
    };
    let (real_user, real_group) = (users[0], groups[0]);
    let of_access = if real_user == 0 {
        capabilities[0].permitted & SEARCH
    } else {
        0
    };
    fs_user == real_user
        && fs_group == real_group
        && capabilities[0].effective & SEARCH == of_access
}
