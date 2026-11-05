use autophys::{Client, connect};
use serde_json::{Value,json};
use std::io::{self,Read};
fn main() {
 let mut text=String::new();io::stdin().read_to_string(&mut text).unwrap();
 let v:Value=serde_json::from_str(&text).unwrap();
 let result=(|| -> autophys::Result<Value> {
  let target=v["target"].as_str().unwrap();
  let client=if v["action"]=="discover" {connect(Some(target))?} else if target.to_ascii_lowercase().starts_with("http") {Client::connect_remote(target,v["key"].as_str().unwrap_or(""))?} else {connect(Some(target))?};
  match v["action"].as_str().unwrap_or("attach") {
   "discover"=>Ok(json!({"projects":client.projects()?.len()})),
   "attach"=>{let inv=client.find_investigation(v["inv"].as_str().unwrap())?;let out=inv.attach_data(v["pid"].as_str().unwrap(),v["observation"].clone())?;Ok(json!({"created":out.created}))},
   "blobs"=>{let a=client.project("A")?;let b=client.project("B")?;let ka=a.put_blob(b"A image","image/png")?;let kb=b.put_blob(b"B playbook","text/markdown")?;assert_eq!(client.open_project("A")?.get_blob(&ka)?.0,b"A image");assert_eq!(client.open_project("B")?.get_blob(&kb)?.0,b"B playbook");assert!(a.get_blob(&kb).is_err());Ok(json!({"ok":true}))},
   _=>unreachable!()
  }
 })();
 match result {Ok(v)=>println!("{}",json!({"ok":true,"result":v})),Err(e)=>println!("{}",json!({"ok":false,"status":e.status(),"code":e.code()}))}
}
