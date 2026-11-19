//! Item storage. Everything above this module sees plain JSON items, and only `dynamo.rs` knows
//! about AWS.

pub mod dynamo;
pub mod keys;
pub mod table;
