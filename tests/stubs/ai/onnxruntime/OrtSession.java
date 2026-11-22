package ai.onnxruntime;
import java.util.*;
/** Compile-only stub! No real inference. */
public class OrtSession implements AutoCloseable {
 public Set<String> getInputNames(){return Collections.singleton("input");}
 public Set<String> getOutputNames(){return Collections.singleton("output");}
 public Map<String,NodeInfo> getInputInfo(){return Collections.singletonMap("input",new NodeInfo());}
 public Map<String,NodeInfo> getOutputInfo(){return Collections.singletonMap("output",new NodeInfo());}
 public Result run(Map<String,? extends OnnxTensor> inputs){return new Result();}
 @Override public void close(){}
 public static class NodeInfo {public TensorInfo getInfo(){return new TensorInfo();}}
 public static class SessionOptions implements AutoCloseable {public void setIntraOpNumThreads(int n){} public void close(){}}
 public static class Result implements AutoCloseable {public Object get(int i){return null;} public void close(){}}
}
